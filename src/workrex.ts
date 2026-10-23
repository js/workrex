import { constants, cpSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { config, fileRules, inside, present, type FileRule } from "./config";
import { git, Repo, validateBranch, worktreePath, worktrees, type Entry } from "./repo";
import { inspectTab, openTab } from "./rex";
import { gh, pullRequest } from "./github";

function installFiles(primary: string, destination: string, rules: FileRule[]) {
  for (const rule of rules) {
    const path = join(destination, rule.path);
    if (present(path)) {
      throw new Error(`File-rule destination already exists: ${path}`);
    }

    let parent = dirname(path);
    while (!present(parent)) {
      parent = dirname(parent);
    }
    if (!inside(destination, realpathSync(parent))) {
      throw new Error(`File-rule destination escapes worktree: ${path}`);
    }
  }

  for (const rule of rules) {
    const path = join(destination, rule.path);
    mkdirSync(dirname(path), { recursive: true });
    if (!inside(destination, realpathSync(dirname(path)))) {
      throw new Error(`File-rule destination escapes worktree: ${path}`);
    }

    const source = join(primary, rule.path);
    if (rule.kind === "symlink") {
      symlinkSync(source, path);
    } else {
      cpSync(source, path, { recursive: true, force: false, errorOnExist: true, mode: constants.COPYFILE_EXCL });
    }
  }
}

function show(repo: Repo, entry: Entry) {
  const cfg = config(repo.primary);
  if (entry.phase === "creating" || entry.phase === "removing") {
    throw new Error(
      `${entry.branch} has unfinished ${entry.phase} work. Inspect its registration before retrying. ` +
        "A failed file-copy step can be abandoned with wr rm and --force.",
    );
  }
  repo.verifyWorktree(entry);

  const status = inspectTab(entry);
  if (!status.windowId) {
    entry.sessionId = currentSession();
    entry.windowId = null;
  }
  entry.windowId = openTab(entry, cfg.panes, `${basename(repo.primary)}/${entry.branch}`);
  repo.save();
  console.log(`${entry.branch}\t${entry.path}\topen`);
}

export function add(repo: Repo, name: string | undefined, options: { branch?: string; pr?: string } = {}) {
  const source = options.branch;
  if (source !== undefined && options.pr !== undefined) {
    throw new Error("--pr cannot be combined with --branch");
  }
  const pr = options.pr === undefined ? undefined : pullRequest(repo.primary, options.pr);
  if (name === undefined && pr) {
    validateBranch(repo.primary, pr.branch);
    name = `pr-${pr.number}-${pr.branch}`;
  }
  if (name === undefined) {
    throw new Error("Provide a worktree name or --pr <number>");
  }
  validateBranch(repo.primary, name);

  const existing = repo.entries.find((entry) => entry.branch === name);
  if (existing) {
    if (source !== undefined) {
      throw new Error("--branch cannot be used with an existing wr worktree");
    }
    show(repo, existing);
    return;
  }

  const cfg = config(repo.primary);
  const label = `${basename(repo.primary)}/${name}`;

  if (worktrees(repo.primary).some((wt) => wt.branch === name)) {
    const hint = pr ? `Use wr add <new-name> --pr ${pr.number}.` : `Open it with wr open ${name}`;
    throw new Error(`Branch ${name} is already in an unmanaged worktree. ${hint}`);
  }
  const path = worktreePath(repo.primary, name);
  if (present(path) || repo.entries.some((entry) => entry.path === path)) {
    throw new Error(`Worktree path already exists: ${path}`);
  }
  const branchExists = repo.branch(name) !== null;
  if (branchExists && pr) {
    throw new Error(`Branch ${name} already exists. Use wr add ${name} to keep it, or wr add <new-name> --pr ${pr.number}.`);
  }
  if (branchExists && source !== undefined) {
    throw new Error("--branch cannot reset an existing branch");
  }

  let start = "HEAD";
  if (source !== undefined) {
    if (!repo.branch(source)) {
      throw new Error(`Source branch does not exist: ${source}`);
    }
    start = `refs/heads/${source}`;
  }
  const startHead = pr?.head ?? git(repo.cwd, ["rev-parse", "--verify", `${start}^{commit}`]).out.trim();
  const rules = fileRules(repo.primary, cfg);

  const entry: Entry = {
    branch: name,
    path,
    gitDir: null,
    sessionId: currentSession(),
    windowId: null,
    phase: "creating",
    expectedHead: null,
    force: false,
  };
  repo.entries.push(entry);
  repo.save();

  try {
    if (pr) {
      gh(repo.primary, ["pr", "checkout", pr.number, "--branch", name, "--worktree", path]);
    } else {
      git(
        repo.primary,
        branchExists ? ["worktree", "add", "--", path, name] : ["worktree", "add", "-b", name, "--", path, startHead],
      );
    }
  } catch (error) {
    const trees = worktrees(repo.primary);
    if (trees.some((wt) => wt.path === path)) {
      // gh can fail after creating the worktree (for example, while setting its upstream).
      // Retain its identity so the normal incomplete-creation cleanup can remove it.
      entry.gitDir = realpathSync(git(path, ["rev-parse", "--absolute-git-dir"]).out.trim());
      repo.save();
    } else {
      if (!branchExists && repo.branch(name) !== null) {
        if (trees.some((wt) => wt.branch === name)) {
          throw new Error(`Creation failed but ${name} is now checked out elsewhere. Inspect its registration before retrying.`);
        }
        git(repo.primary, ["update-ref", "-d", `refs/heads/${name}`, startHead]);
      }
      repo.entries = repo.entries.filter((item) => item !== entry);
      repo.save();
    }
    throw error;
  }

  entry.gitDir = realpathSync(git(path, ["rev-parse", "--absolute-git-dir"]).out.trim());
  repo.save();

  installFiles(repo.primary, path, rules);
  entry.phase = "ready";
  repo.save();

  entry.windowId = openTab(entry, cfg.panes, label);
  repo.save();
  console.log(`${name}\t${path}\topen`);
}

export function open(repo: Repo, name: string) {
  const existing = repo.entries.find((entry) => entry.branch === name);
  if (existing) {
    show(repo, existing);
    return;
  }

  const wt = worktrees(repo.primary).find((item) => item.branch === name);
  if (!wt) {
    throw new Error(`No worktree has branch ${name}. Create one with wr add ${name}`);
  }
  if (!present(wt.path)) {
    throw new Error(`Worktree is missing: ${wt.path}`);
  }
  const owner = repo.entries.find((entry) => entry.path === wt.path);
  if (owner) {
    throw new Error(`${wt.path} is already registered as ${owner.branch}`);
  }

  const entry: Entry = {
    branch: name,
    path: wt.path,
    gitDir: realpathSync(git(wt.path, ["rev-parse", "--absolute-git-dir"]).out.trim()),
    sessionId: currentSession(),
    windowId: null,
    phase: "external",
    expectedHead: null,
    force: false,
  };
  repo.entries.push(entry);
  show(repo, entry);
}

function currentSession(): string {
  if (!process.env.REX_SESSION) {
    throw new Error("Run wr inside a Rex session, or set REX_SESSION to its full ID");
  }
  return process.env.REX_SESSION;
}

export function list(repo: Repo, options: { verbose?: boolean } = {}) {
  const headers = ["WORKTREE", "BRANCH", "TAB", "STATE"];
  if (options.verbose) headers.push("PATH");
  const trees = new Map(worktrees(repo.primary).map((wt) => [wt.path, wt]));
  const rows = [headers, ...repo.entries.map((entry) => {
    const status = inspectTab(entry);
    const tab = status.windowId ? "open" : "closed";
    const state = present(entry.path) ? entry.phase : "missing";
    const wt = trees.get(entry.path);
    const branch = wt ? wt.branch ?? "(detached)" : "-";
    const row = [entry.branch, branch, tab, state];
    return options.verbose ? [...row, entry.path] : row;
  })];
  const widths = headers.map((_, column) =>
    rows.reduce((width, row) => Math.max(width, Bun.stringWidth(row[column])), 0),
  );
  for (const row of rows) {
    console.log(row.map((cell, column) =>
      column === row.length - 1 ? cell : cell + " ".repeat(widths[column] - Bun.stringWidth(cell)),
    ).join("  "));
  }
}
