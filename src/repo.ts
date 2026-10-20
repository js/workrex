import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { object, present, text } from "./config";

export function git(cwd: string, args: string[], check = true): { code: number; out: string; err: string } {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_MERGE_AUTOEDIT: "no" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const answer = { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
  if (check && answer.code !== 0) {
    throw new Error(answer.err.trim() || `git ${args[0]} failed`);
  }
  return answer;
}

export type Worktree = { path: string; branch: string | null; bare: boolean; locked: boolean };
export type Entry = {
  branch: string;
  path: string;
  gitDir: string | null;
  sessionId: string;
  windowId: string | null;
  phase: "creating" | "ready" | "removing" | "external";
  expectedHead: string | null;
  force: boolean;
};

export function worktrees(cwd: string): Worktree[] {
  const blocks = git(cwd, ["worktree", "list", "--porcelain", "-z"]).out.split("\0\0").filter(Boolean);
  return blocks.map((block) => {
    const fields = block.split("\0");
    const path = fields.find((f) => f.startsWith("worktree "))?.slice(9);
    if (!path) {
      throw new Error("Invalid git worktree output");
    }
    const ref = fields.find((f) => f.startsWith("branch "))?.slice(7);

    return {
      path: resolve(path),
      branch: ref?.startsWith("refs/heads/") ? ref.slice(11) : null,
      bare: fields.includes("bare"),
      locked: fields.some((f) => f === "locked" || f.startsWith("locked ")),
    };
  });
}

function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : text(value, label);
}

function parseEntry(value: unknown): Entry {
  const entry = object(value, "registry entry");
  const phase = entry.phase;
  if (phase !== "creating" && phase !== "ready" && phase !== "removing" && phase !== "external") {
    throw new Error("Invalid registry phase");
  }
  if (typeof entry.force !== "boolean") {
    throw new Error("Invalid registry force flag");
  }

  return {
    branch: text(entry.branch, "branch"),
    path: text(entry.path, "path"),
    gitDir: nullableText(entry.gitDir, "gitDir"),
    sessionId: text(entry.sessionId, "sessionId"),
    windowId: nullableText(entry.windowId, "windowId"),
    phase,
    expectedHead: nullableText(entry.expectedHead, "expectedHead"),
    force: entry.force,
  };
}

export class Repo {
  readonly primary: string;
  readonly common: string;
  readonly stateDir: string;
  entries: Entry[] = [];

  constructor(readonly cwd: string) {
    this.common = realpathSync(git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).out.trim());
    const primary = worktrees(cwd)[0];
    if (!primary || primary.bare) {
      throw new Error("wr requires a non-bare repository with a primary checkout");
    }
    this.primary = realpathSync(primary.path);
    this.stateDir = join(this.common, "workrex");
    this.load();
  }

  load() {
    const path = join(this.stateDir, "state.json");
    if (!present(path)) {
      this.entries = [];
      return;
    }

    const state = object(JSON.parse(readFileSync(path, "utf8")), "registry");
    if (state.version !== 1 || !Array.isArray(state.entries)) {
      throw new Error("Unsupported wr registry");
    }
    this.entries = state.entries.map(parseEntry);
    if (new Set(this.entries.map((entry) => entry.branch)).size !== this.entries.length) {
      throw new Error("Duplicate branches in wr registry");
    }
  }

  save() {
    mkdirSync(this.stateDir, { recursive: true });
    const path = join(this.stateDir, `state.${process.pid}.tmp`);
    writeFileSync(path, JSON.stringify({ version: 1, entries: this.entries }, null, 2) + "\n", { mode: 0o600 });
    renameSync(path, join(this.stateDir, "state.json"));
  }

  locked<T>(run: () => T): T {
    mkdirSync(this.stateDir, { recursive: true });
    const lock = join(this.stateDir, "lock");
    try {
      mkdirSync(lock);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
        throw new Error(
          `Another wr mutation holds ${lock}. If interrupted, check its owner.json before removing the stale lock.`,
        );
      }
      throw error;
    }

    try {
      const owner = { pid: process.pid, command: process.argv, started: new Date().toISOString() };
      writeFileSync(join(lock, "owner.json"), JSON.stringify(owner));
      this.load();
      return run();
    } finally {
      rmSync(lock, { recursive: true });
    }
  }

  entry(branch: string): Entry {
    const entry = this.entries.find((e) => e.branch === branch);
    if (!entry) {
      throw new Error(`Not a wr worktree: ${branch}`);
    }
    return entry;
  }

  branch(name: string): string | null {
    validateBranch(this.primary, name);
    const result = git(this.primary, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], false);
    if (result.code === 1) {
      return null;
    }
    if (result.code !== 0) {
      throw new Error(result.err.trim() || `Cannot resolve branch ${name}`);
    }
    return result.out.trim();
  }

  defaultBranch(override?: string): string {
    if (override) {
      if (!this.branch(override)) {
        throw new Error(`Configured default branch does not exist locally: ${override}`);
      }
      return override;
    }

    const remote = git(this.primary, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], false);
    if (remote.code === 0) {
      const name = remote.out.trim().replace(/^refs\/remotes\/origin\//, "");
      if (this.branch(name)) {
        return name;
      }
    }

    for (const name of ["main", "master"]) {
      if (this.branch(name)) {
        return name;
      }
    }
    throw new Error("Cannot determine the default branch. Set main_branch in .workrex.json or use merge --into.");
  }

  verifyWorktree(entry: Entry): Worktree {
    const wt = worktrees(this.primary).find((item) => item.path === entry.path);
    if (!wt || !present(entry.path)) {
      throw new Error(`Worktree is missing: ${entry.path}. Its registration has been retained.`);
    }
    if (realpathSync(entry.path) === this.primary || wt.locked) {
      throw new Error(`Refusing protected or locked worktree: ${entry.path}`);
    }

    const gitDir = realpathSync(git(entry.path, ["rev-parse", "--absolute-git-dir"]).out.trim());
    const common = realpathSync(git(entry.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).out.trim());
    if (gitDir !== entry.gitDir || common !== this.common) {
      throw new Error(`Worktree ownership changed: ${entry.path}`);
    }
    return wt;
  }

  verify(entry: Entry): Worktree {
    const wt = this.verifyWorktree(entry);
    if (wt.branch !== entry.branch && !(wt.branch === null && operation(entry.path))) {
      throw new Error(`Worktree no longer has branch ${entry.branch}: ${entry.path}`);
    }
    return wt;
  }
}

export function validateBranch(cwd: string, name: string) {
  if (
    name.startsWith("-") ||
    (name === "HEAD" || name === "@") ||
    /[\x00-\x20\x7f]/.test(name) ||
    git(cwd, ["check-ref-format", `refs/heads/${name}`], false).code !== 0
  ) {
    throw new Error(`Invalid branch name: ${JSON.stringify(name)}`);
  }
}

export function dirty(path: string): boolean {
  return git(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).out.length > 0;
}

export function operation(path: string): string | null {
  for (const name of ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer"]) {
    const file = git(path, ["rev-parse", "--path-format=absolute", "--git-path", name]).out.trim();
    if (!present(file)) {
      continue;
    }

    if (name.startsWith("rebase-")) {
      return "rebase";
    }
    if (name === "MERGE_HEAD") {
      return "merge";
    }
    return "cherry-pick/revert";
  }
  return null;
}

export function requireIdle(path: string) {
  const active = operation(path);
  if (active) {
    throw new Error(`An unfinished ${active} exists in ${path}. Continue or abort it with Git before retrying, even with --force.`);
  }
}

export function worktreePath(primary: string, branch: string): string {
  return join(dirname(primary), `${primary.split("/").at(-1)}__worktrees`, encodeURIComponent(branch));
}
