import { closeSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { config, present } from "./config";
import { dirty, git, Repo, requireIdle, worktrees, type Entry } from "./repo";
import { closeTab, inspectTab } from "./rex";

export function merge(repo: Repo, name: string, into: string | undefined, force: boolean): boolean {
  const entry = repo.entry(name);
  if (entry.phase === "external") {
    throw new Error(
      `wr did not create ${name}, so it will not merge or delete it. Merge with Git, then run wr rm ${name} to close its tab.`,
    );
  }
  if (entry.phase === "removing") {
    return finishRemoval(repo, entry);
  }
  if (entry.phase !== "ready") {
    throw new Error("Worktree creation is incomplete. Inspect it before removing it.");
  }
  repo.verify(entry);
  requireIdle(entry.path);

  const target = into ?? repo.defaultBranch(config(repo.primary).main_branch);
  if (target === name) {
    throw new Error("Cannot merge a branch into itself");
  }
  const previous = repo.branch(target);
  if (!previous) {
    throw new Error(`Target branch does not exist locally: ${target}`);
  }
  const checkout = worktrees(repo.primary).find((wt) => wt.branch === target);
  if (checkout) {
    if (checkout.locked) {
      throw new Error(`Target worktree is locked: ${checkout.path}`);
    }
    requireIdle(checkout.path);
    if (dirty(checkout.path)) {
      throw new Error(`Target checkout is dirty: ${checkout.path}`);
    }
  }

  inspectTab(entry);
  if (dirty(entry.path)) {
    if (!force) {
      throw new Error(`Worktree is dirty: ${entry.path}. --force discards these changes.`);
    }
    git(entry.path, ["reset", "--hard", "HEAD"]);
    git(entry.path, ["clean", "-fd"]);
    if (dirty(entry.path)) {
      throw new Error("Git left dirty files, such as a nested repository or submodule. Resolve them before retrying.");
    }
  }

  const rebased = git(
    entry.path,
    ["-c", "rebase.autoStash=false", "-c", "rebase.updateRefs=false", "rebase", previous],
    false,
  );
  if (rebased.code !== 0) {
    throw new Error(
      `${rebased.err.trim()}\nRebase stopped in ${entry.path}. Fix conflicts, then run git rebase --continue there, ` +
        "or git rebase --abort. Retry wr merge with the explicit name afterward.",
    );
  }
  const head = repo.branch(name);
  if (!head) {
    throw new Error(`Source branch disappeared: ${name}`);
  }
  if (dirty(entry.path)) {
    throw new Error("Source changed during rebase. Clean it before retrying.");
  }
  if (repo.branch(target) !== previous) {
    throw new Error("Target branch changed during rebase. Retry the merge.");
  }
  const now = worktrees(repo.primary).find((wt) => wt.branch === target);
  if (checkout?.path !== now?.path) {
    throw new Error("Target checkout changed during rebase. Retry the merge.");
  }

  if (now) {
    requireIdle(now.path);
    if (dirty(now.path)) {
      throw new Error(`Target checkout became dirty: ${now.path}`);
    }
    git(now.path, ["merge", "--ff-only", head]);
  } else {
    git(repo.primary, ["update-ref", `refs/heads/${target}`, head, previous]);
  }

  entry.phase = "removing";
  entry.expectedHead = head;
  entry.force = false;
  entry.removal = { branch: name, keepBranch: false };
  repo.save();
  console.log(`Rebased ${name} onto ${target} and fast-forwarded ${target}.`);
  return finishRemoval(repo, entry);
}

export function remove(
  repo: Repo,
  name: string,
  { force = false, verbose = false, keepBranch = false }: { force?: boolean; verbose?: boolean; keepBranch?: boolean } = {},
): boolean {
  const entry = repo.entry(name);
  if (entry.phase === "external") {
    return untrack(repo, entry, `Closed ${entry.branch}. wr did not create this worktree, so it and its branch remain.`, verbose);
  }
  if (entry.phase === "removing") {
    if (keepBranch && !entry.removal?.keepBranch) {
      // A retry may preserve more, but must never choose a different branch to delete.
      entry.removal = { branch: entry.removal ? entry.removal.branch : entry.branch, keepBranch: true };
      repo.save();
    }
    return finishRemoval(repo, entry, verbose);
  }
  if (verbose) console.log(`Verifying worktree: ${entry.path}`);
  const checkout = repo.verifyWorktree(entry);
  const branchName = checkout.branch;

  if (verbose) console.log("Resolving default branch");
  const target = repo.defaultBranch(config(repo.primary).main_branch);
  if (branchName === target) {
    throw new Error("Refusing to remove the default branch");
  }
  if (verbose) console.log(`Resolving branch: ${branchName ?? "(detached)"}`);
  const head = branchName === null
    ? git(entry.path, ["rev-parse", "--verify", "HEAD"]).out.trim()
    : repo.branch(branchName);
  if (!head) {
    throw new Error(`Source branch disappeared: ${branchName}`);
  }

  if (verbose) console.log(`Inspecting tab: ${name}`);
  inspectTab(entry);
  if (!force) {
    if (verbose) console.log(`Checking for unfinished Git operations: ${entry.path}`);
    requireIdle(entry.path);
    if (verbose) console.log(`Checking for uncommitted changes: ${entry.path}`);
    if (dirty(entry.path)) {
      throw new Error(`Worktree is dirty: ${entry.path}. --force abandons it.`);
    }
    // Keeping a branch preserves its commits; detached HEAD still needs a reachability check.
    if (!keepBranch || branchName === null) {
      const source = branchName ?? "Detached HEAD";
      if (verbose) console.log(`Checking ${source} is merged into ${target}`);
      const merged = git(repo.primary, ["merge-base", "--is-ancestor", head, `refs/heads/${target}`], false);
      if (merged.code > 1) throw new Error(merged.err.trim() || "Could not check unmerged commits");
      if (merged.code !== 0) {
        const warning = `${source} has commits not merged into ${target}.`;
        if (!process.stdin.isTTY) {
          throw new Error(`${warning} Re-run interactively to confirm, or use --force to abandon them.`);
        }
        const action = branchName === null ? "abandon its detached commits" : `delete branch ${branchName}`;
        const answer = prompt(`${warning}\nRemove worktree ${name} at ${entry.path} and ${action}? [y/N]`);
        if (answer?.trim().toLowerCase() !== "y") {
          console.log("Aborted.");
          return false;
        }
      }
    }
  }

  if (verbose) console.log(`Recording removal: ${name}`);
  entry.phase = "removing";
  entry.expectedHead = head;
  entry.force = force;
  entry.removal = { branch: branchName, keepBranch };
  repo.save();
  return finishRemoval(repo, entry, verbose);
}

function finishRemoval(repo: Repo, entry: Entry, verbose = false): boolean {
  if (verbose) console.log(`Checking removal state: ${entry.branch}`);
  const expected = entry.expectedHead;
  if (!expected) {
    throw new Error("Incomplete removal registration; refusing cleanup");
  }
  const branchName = entry.removal ? entry.removal.branch : entry.branch;
  const keepBranch = entry.removal?.keepBranch ?? false;
  const branch = branchName === null ? null : repo.branch(branchName);
  if (!keepBranch && branch !== null && branch !== expected) {
    throw new Error("Source branch changed after cleanup began. Registration retained; inspect it before retrying.");
  }

  if (verbose) console.log(`Inspecting worktree: ${entry.path}`);
  const tree = worktrees(repo.primary).find((wt) => wt.path === entry.path);
  if (tree && !present(entry.path)) {
    const changed = entry.removal ? tree.branch !== branchName : tree.branch !== null && tree.branch !== branchName;
    if (tree.locked || changed) {
      throw new Error("Missing worktree registration changed after cleanup began");
    }
    if (verbose) console.log(`Removing worktree metadata: ${entry.path}`);
    git(repo.primary, ["worktree", "remove", "--force", "--", entry.path]);
    console.log(`Removed worktree metadata: ${entry.path}`);
  } else if (tree || present(entry.path)) {
    if (verbose) console.log(`Verifying worktree: ${entry.path}`);
    if (entry.removal) {
      const checkout = repo.verifyWorktree(entry);
      if (checkout.branch !== branchName) {
        throw new Error("Worktree branch changed after cleanup began. Registration retained; inspect it before retrying.");
      }
      if (git(entry.path, ["rev-parse", "--verify", "HEAD"]).out.trim() !== expected) {
        throw new Error("Worktree HEAD changed after cleanup began. Registration retained; inspect it before retrying.");
      }
      if (!entry.force) requireIdle(entry.path);
    } else {
      repo.verify(entry);
    }
    if (branchName !== null && !branch) {
      throw new Error("Source branch disappeared before worktree cleanup");
    }
    if (verbose) console.log(`Removing worktree: ${entry.path}`);
    git(repo.primary, ["worktree", "remove", ...(entry.force ? ["--force"] : []), "--", entry.path]);
    console.log(`Removed worktree: ${entry.path}`);
  } else {
    console.log(`Worktree already removed: ${entry.path}`);
  }

  if (branchName === null) {
    console.log("No branch deleted: worktree had a detached HEAD");
  } else if (keepBranch) {
    console.log(`${branch ? "Kept branch" : "Branch already removed"}: ${branchName}`);
  } else if (branch) {
    if (verbose) console.log(`Checking branch checkouts: ${branchName}`);
    if (worktrees(repo.primary).some((wt) => wt.branch === branchName)) {
      throw new Error("Source branch is checked out elsewhere. Refusing to delete it.");
    }
    if (verbose) console.log(`Deleting branch: ${branchName}`);
    git(repo.primary, ["update-ref", "-d", `refs/heads/${branchName}`, expected]);
    console.log(`Deleted branch: ${branchName}`);
  } else {
    console.log(`Branch already removed: ${branchName}`);
  }

  return untrack(repo, entry, `Removed ${entry.branch}.`, verbose);
}

function untrack(repo: Repo, entry: Entry, done: string, verbose = false): boolean {
  if (verbose) console.log(`Inspecting tab: ${entry.branch}`);
  const status = inspectTab(entry);
  if (status.ownTab) {
    return true;
  }
  if (verbose) console.log(`${status.windowId ? "Closing tab" : "Confirming tab is closed"}: ${entry.branch}`);
  closeTab(entry);
  console.log(`${status.windowId ? "Closed tab" : "Tab already closed"}: ${entry.branch}`);
  if (verbose) console.log(`Removing registration: ${entry.branch}`);
  repo.entries = repo.entries.filter((item) => item !== entry);
  repo.save();
  console.log(`Removed registration: ${entry.branch}`);
  console.log(done);
  return false;
}

export function deferTabCleanup(repo: Repo, name: string, verbose = false) {
  if (verbose) console.log(`Starting background tab cleanup: ${name}`);
  const log = join(repo.stateDir, "cleanup.log");
  const fd = openSync(log, "a", 0o600);
  try {
    const child = spawn(process.execPath, [resolve(import.meta.dir, "../wr"), "rm", name, ...(verbose ? ["--verbose"] : [])], {
      cwd: repo.primary,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: { ...process.env, REX_BLOCK: "" },
    });
    child.on("error", (error) => {
      console.error(`wr: tab cleanup could not start: ${error.message}. Retry wr rm with the same name.`);
    });
    child.unref();
    console.log(
      "Closing this tab in the background. " +
        `If it stays open, retry wr rm with the same name. Log: ${log}`,
    );
  } finally {
    closeSync(fd);
  }
}
