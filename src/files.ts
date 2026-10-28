import {
  constants, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync,
  realpathSync, renameSync, rmSync, symlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileRules, inside, present, type Config, type FileRule } from "./config";
import { git, Repo, worktrees } from "./repo";

type FilePlan = { source: string; destination: string; rules: FileRule[] };

export function sourceCheckout(repo: Repo, branch?: string): string {
  let path: string;
  if (branch === undefined) {
    path = git(repo.cwd, ["rev-parse", "--show-toplevel"]).out.trim();
  } else {
    if (!repo.branch(branch)) {
      throw new Error(`Source branch does not exist locally: ${branch}`);
    }
    const matches = worktrees(repo.primary).filter((wt) => wt.branch === branch);
    if (matches.length !== 1) {
      throw new Error(matches.length
        ? `Source branch has multiple checkouts: ${branch}`
        : `Source branch ${branch} has no checkout. Check it out before applying file rules.`);
    }
    path = matches[0].path;
  }
  if (!existsSync(path)) {
    throw new Error(`Source checkout is missing: ${path}`);
  }
  const common = realpathSync(git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).out.trim());
  if (common !== repo.common) {
    throw new Error(`Source checkout belongs to another repository: ${path}`);
  }
  return realpathSync(path);
}

export function planFiles(repo: Repo, source: string, destination: string, cfg: Config): FilePlan {
  if (source === destination) {
    throw new Error("Cannot sync a worktree from itself");
  }

  // Keep symlink chains between this repository's checkouts, but never let
  // sources escape the repository or point back into the destination.
  const roots = worktrees(repo.primary).filter((wt) => existsSync(wt.path)).map((wt) => realpathSync(wt.path))
    .filter((path) => path !== destination);
  const rules = fileRules(source, cfg, roots);
  for (const rule of rules) {
    const resolved = realpathSync(join(source, rule.path));
    if (inside(destination, resolved) || inside(resolved, destination)) {
      throw new Error(`File-rule source overlaps destination worktree: ${rule.path}`);
    }
  }
  return { source, destination, rules };
}

function checkParents(destination: string, path: string) {
  for (let parent = dirname(path); parent !== destination; parent = dirname(parent)) {
    if (!inside(destination, parent)) {
      throw new Error(`File-rule destination escapes worktree: ${path}`);
    }
    const stat = lstatSync(parent, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
      throw new Error(`File-rule destination parent is not a real directory: ${parent}`);
    }
  }
}

function sameLink(path: string, source: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true
    && resolve(dirname(path), readlinkSync(path)) === source;
}

function checkReplacement(path: string) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat?.isDirectory()) {
    for (const child of readdirSync(path)) {
      if (child === ".git") {
        throw new Error(`Cannot overwrite Git metadata: ${path}`);
      }
      checkReplacement(join(path, child));
    }
  } else if (stat && !stat.isFile() && !stat.isSymbolicLink()) {
    throw new Error(`Copy destination is not a regular file, directory, or symlink: ${path}`);
  }
}

export function installFiles(plan: FilePlan, overwrite = false) {
  const { source: root, destination, rules } = plan;

  // Validate every destination before replacing anything.
  for (const rule of rules) {
    const path = join(destination, rule.path);
    checkParents(destination, path);
    if (!present(path)) continue;
    if (!overwrite) {
      throw new Error(`File-rule destination already exists: ${path}`);
    }
    if (rule.kind === "symlink") {
      if (!sameLink(path, join(root, rule.path))) {
        throw new Error(`Conflicting symlink destination: ${path}. Expected a link to ${join(root, rule.path)}`);
      }
    } else {
      checkReplacement(path);
    }
  }

  for (const rule of rules) {
    const path = join(destination, rule.path);
    const source = join(root, rule.path);
    checkParents(destination, path);
    mkdirSync(dirname(path), { recursive: true });
    if (rule.kind === "symlink") {
      if (overwrite && sameLink(path, source)) continue;
      symlinkSync(source, path);
    } else if (!overwrite) {
      cpSync(source, path, { recursive: true, force: false, errorOnExist: true, mode: constants.COPYFILE_EXCL });
    } else {
      // Stage before removing the old target, and replace rather than copying through
      // destination symlinks/hardlinks. Directories are replaced, not merged.
      const temporary = mkdtempSync(join(dirname(path), ".wr-copy-"));
      try {
        const staged = join(temporary, "source");
        cpSync(source, staged, { recursive: true, force: false, errorOnExist: true, mode: constants.COPYFILE_EXCL });
        rmSync(path, { recursive: true, force: true });
        renameSync(staged, path);
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    }
  }
}
