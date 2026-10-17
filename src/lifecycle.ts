import { closeSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { config, present } from "./config";
import { dirty, git, Repo, requireIdle, worktrees, type Entry } from "./repo";
import { closeTab, inspectTab } from "./rex";

export function merge(repo: Repo, name: string, into: string | undefined, force: boolean): boolean {
  const entry = repo.entry(name);
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
  repo.save();
  console.log(`Merged ${name} into ${target}.`);
  return finishRemoval(repo, entry);
}

export function remove(repo: Repo, name: string, force: boolean): boolean {
  const entry = repo.entry(name);
  if (entry.phase === "removing") {
    return finishRemoval(repo, entry);
  }
  repo.verify(entry);

  const target = repo.defaultBranch(config(repo.primary).main_branch);
  if (name === target) {
    throw new Error("Refusing to remove the default branch");
  }
  const head = repo.branch(name);
  if (!head) {
    throw new Error(`Source branch disappeared: ${name}`);
  }

  inspectTab(entry);
  if (!force) {
    requireIdle(entry.path);
    if (dirty(entry.path)) {
      throw new Error(`Worktree is dirty: ${entry.path}. --force abandons it.`);
    }
    if (git(repo.primary, ["merge-base", "--is-ancestor", head, `refs/heads/${target}`], false).code !== 0) {
      throw new Error(`${name} has commits not merged into ${target}. --force abandons them.`);
    }
  }

  entry.phase = "removing";
  entry.expectedHead = head;
  entry.force = force;
  repo.save();
  return finishRemoval(repo, entry);
}

function finishRemoval(repo: Repo, entry: Entry): boolean {
  const expected = entry.expectedHead;
  if (!expected) {
    throw new Error("Incomplete removal registration; refusing cleanup");
  }
  const branch = repo.branch(entry.branch);
  if (branch !== null && branch !== expected) {
    throw new Error("Source branch changed after cleanup began. Registration retained; inspect it before retrying.");
  }

  const tree = worktrees(repo.primary).find((wt) => wt.path === entry.path);
  if (tree && !present(entry.path)) {
    if (tree.locked || (tree.branch !== null && tree.branch !== entry.branch)) {
      throw new Error("Missing worktree registration changed after cleanup began");
    }
    git(repo.primary, ["worktree", "remove", "--force", "--", entry.path]);
  } else if (tree || present(entry.path)) {
    repo.verify(entry);
    if (!branch) {
      throw new Error("Source branch disappeared before worktree cleanup");
    }
    git(repo.primary, ["worktree", "remove", ...(entry.force ? ["--force"] : []), "--", entry.path]);
  }

  if (branch) {
    if (worktrees(repo.primary).some((wt) => wt.branch === entry.branch)) {
      throw new Error("Source branch is checked out elsewhere. Refusing to delete it.");
    }
    git(repo.primary, ["update-ref", "-d", `refs/heads/${entry.branch}`, expected]);
  }

  const status = inspectTab(entry);
  if (status.ownTab) {
    return true;
  }
  closeTab(entry);
  repo.entries = repo.entries.filter((item) => item !== entry);
  repo.save();
  console.log(`Removed ${entry.branch}.`);
  return false;
}

export function deferTabCleanup(repo: Repo, name: string) {
  const log = join(repo.stateDir, "cleanup.log");
  const fd = openSync(log, "a", 0o600);
  try {
    const child = spawn(process.execPath, [resolve(import.meta.dir, "../wr"), "rm", name], {
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
      "Git cleanup complete. Closing this tab in the background. " +
        `If it stays open, retry wr rm with the same name. Log: ${log}`,
    );
  } finally {
    closeSync(fd);
  }
}
