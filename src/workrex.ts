import { constants, cpSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { config, fileRules, inside, present, type FileRule } from "./config";
import { git, identity, Repo, validateBranch, worktreePath, worktrees, type Entry } from "./repo";
import { inspectTab, openTab } from "./rex";

function installFiles(primary: string, destination: string, rules: FileRule[]) {
  for (const rule of rules) {
    const path = join(destination, rule.path);
    if (present(path)) throw new Error(`File-rule destination already exists: ${path}`);
    let parent = dirname(path);
    while (!present(parent)) parent = dirname(parent);
    if (!inside(destination, realpathSync(parent))) throw new Error(`File-rule destination escapes worktree: ${path}`);
  }
  for (const rule of rules) {
    const path = join(destination, rule.path);
    mkdirSync(dirname(path), { recursive: true });
    if (!inside(destination, realpathSync(dirname(path)))) throw new Error(`File-rule destination escapes worktree: ${path}`);
    const source = join(primary, rule.path);
    if (rule.kind === "symlink") symlinkSync(source, path);
    else cpSync(source, path, { recursive: true, force: false, errorOnExist: true, mode: constants.COPYFILE_EXCL });
  }
}

export function add(repo: Repo, name: string, source?: string) {
  validateBranch(repo.primary, name);
  const cfg = config(repo.primary);
  const existing = repo.entries.find((entry) => entry.branch === name);
  if (existing) {
    if (source) throw new Error("--branch cannot be used with an existing wr worktree");
    repo.verify(existing);
    if (existing.phase !== "ready") throw new Error(`${name} has unfinished ${existing.phase} work. Inspect it, then use wr rm ${name} --force to abandon it.`);
    const status = inspectTab(existing);
    if (!status.sessionExists) {
      existing.sessionId = currentSession();
      existing.windowId = null;
      repo.save();
    }
    existing.windowId = openTab(existing, cfg.panes);
    repo.save();
    console.log(`${name}\t${existing.path}\topen`);
    return;
  }
  if (worktrees(repo.primary).some((wt) => wt.branch === name)) throw new Error(`Branch ${name} is already in an unmanaged worktree`);
  const path = worktreePath(repo.primary, name);
  if (present(path) || repo.entries.some((entry) => entry.path === path)) throw new Error(`Worktree path already exists: ${path}`);
  const branchExists = repo.branch(name) !== null;
  if (branchExists && source) throw new Error("--branch cannot reset an existing branch");
  let start = "HEAD";
  if (source) {
    if (!repo.branch(source)) throw new Error(`Source branch does not exist: ${source}`);
    start = `refs/heads/${source}`;
  }
  const startHead = git(repo.cwd, ["rev-parse", "--verify", `${start}^{commit}`]).out.trim();
  const rules = fileRules(repo.primary, cfg);
  const entry: Entry = {
    branch: name, path, gitDir: null, identity: null,
    sessionId: currentSession(), windowId: null,
    label: `wr:${crypto.randomUUID()} ${basename(repo.primary)}/${name}`,
    phase: "creating", expectedHead: null, force: false,
  };
  // Save the tab label before creation so a timed-out Rex request can be recovered.
  repo.entries.push(entry);
  repo.save();
  try {
    git(repo.primary, branchExists ? ["worktree", "add", "--", path, name] : ["worktree", "add", "-b", name, "--", path, startHead]);
  } catch (error) {
    if (!worktrees(repo.primary).some((wt) => wt.path === path)) {
      repo.entries = repo.entries.filter((item) => item !== entry);
      repo.save();
    }
    throw error;
  }
  entry.gitDir = realpathSync(git(path, ["rev-parse", "--absolute-git-dir"]).out.trim());
  entry.identity = identity(path);
  repo.save();
  installFiles(repo.primary, path, rules);
  entry.phase = "ready";
  repo.save();
  entry.windowId = openTab(entry, cfg.panes);
  repo.save();
  console.log(`${name}\t${path}\topen`);
}

function currentSession(): string {
  if (!process.env.REX_SESSION) throw new Error("Run wr add inside a Rex session, or set REX_SESSION to its full ID");
  return process.env.REX_SESSION;
}

export function list(repo: Repo) {
  console.log("BRANCH\tTAB\tSTATE\tPATH");
  for (const entry of repo.entries) {
    const status = inspectTab(entry);
    console.log(`${entry.branch}\t${status.windowId ? "open" : "closed"}\t${present(entry.path) ? entry.phase : "missing"}\t${entry.path}`);
  }
}
