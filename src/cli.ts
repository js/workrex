import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { Repo } from "./repo";
import { checkConfig } from "./config";
import { completionNames, fishScript } from "./completions";
import { add, list, open } from "./workrex";
import { deferTabCleanup, merge, remove } from "./lifecycle";

export async function run(args: string[]) {
  if (process.env.WR_LUA) {
    process.env.WR_LUA = resolve(process.env.WR_LUA);
  }

  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    console.log(
      "Usage: wr <command>\n\n" +
        "  wr add <name> [--branch <source>]\n" +
        "    Create a worktree and open its Rex tab, or reopen a registered one.\n" +
        "    New branches start at HEAD unless --branch is given.\n\n" +
        "  wr add [<name>] --pr <number>\n" +
        "    Check out a GitHub PR with gh and open its configured Rex tab.\n" +
        "    Defaults to the PR's branch name; cannot be combined with --branch.\n\n" +
        "  wr open <name>\n" +
        "    Focus or reopen a Rex tab for an existing worktree, including one created outside wr.\n\n" +
        "  wr merge <name> [--into <target>] [--force]\n" +
        "    Rebase onto the default branch or --into target, fast-forward it, then remove\n" +
        "    the worktree, branch, and tab. --force discards uncommitted source changes.\n\n" +
        "  wr rm <name> [--force] [--keep-branch] [--verbose]\n" +
        "    Remove a worktree, its current branch, and tab; --keep-branch preserves the branch.\n" +
        "    Unmerged commits require confirmation; --force discards dirty or unmerged work.\n" +
        "    For worktrees created outside wr, only close and unregister the tab.\n" +
        "    --verbose also prints each operation as it starts.\n\n" +
        "  wr ls [--verbose]\n" +
        "    List registered worktrees with tab status and state; differing branches appear in brackets.\n" +
        "    --verbose shows separate branch and path columns.\n\n" +
        "  wr config check\n" +
        "    Check global and current-directory .jsonc files for syntax errors, not settings validity.\n\n" +
        "  wr completions fish\n" +
        "    Print the Fish completion script. Install it with wr completions fish | source in ~/.config/fish/completions/wr.fish.",
    );
    return;
  }

  if (args[0] === "__complete") {
    const kind = args[1];
    if (args.length === 2 && (kind === "registered" || kind === "open" || kind === "branches")) {
      for (const name of completionNames(process.cwd(), kind)) {
        console.log(name);
      }
    }
    return;
  }

  if (args[0] === "completions") {
    if (args.length !== 2 || args[1] !== "fish") {
      throw new Error("Usage: wr completions fish");
    }
    process.stdout.write(fishScript());
    return;
  }

  const command = args[0];

  if (command === "config") {
    if (args.length !== 2 || args[1] !== "check") {
      throw new Error("Usage: wr config check");
    }
    checkConfig(process.cwd());
  } else if (command === "ls" || command === "list") {
    let verbose: boolean;
    try {
      const parsed = parseArgs({
        args: args.slice(1),
        options: { verbose: { type: "boolean" } },
        allowPositionals: false,
        strict: true,
      });
      verbose = parsed.values.verbose ?? false;
    } catch {
      throw new Error("Usage: wr ls [--verbose]");
    }
    list(new Repo(process.cwd()), { verbose });
  } else if (command === "add") {
    const parsed = parseArgs({
      args: args.slice(1),
      options: { branch: { type: "string" }, pr: { type: "string" } },
      allowPositionals: true,
      strict: true,
    });
    if (parsed.positionals.length > 1 || (parsed.values.pr === undefined && parsed.positionals.length !== 1)) {
      throw new Error("Usage: wr add <name> [--branch <source>] or wr add [<name>] --pr <number>");
    }
    if (parsed.values.pr !== undefined && parsed.values.branch !== undefined) {
      throw new Error("--pr cannot be combined with --branch");
    }

    const repo = new Repo(process.cwd());
    repo.locked(() => add(repo, parsed.positionals[0], parsed.values));
  } else if (command === "open") {
    let name: string;
    try {
      const parsed = parseArgs({
        args: args.slice(1),
        options: {},
        allowPositionals: true,
        strict: true,
      });
      if (parsed.positionals.length !== 1) {
        throw new Error("Usage: wr open <name>");
      }
      name = parsed.positionals[0];
    } catch {
      throw new Error("Usage: wr open <name>");
    }

    const repo = new Repo(process.cwd());
    repo.locked(() => open(repo, name));
  } else if (command === "merge") {
    const parsed = parseArgs({
      args: args.slice(1),
      options: { into: { type: "string" }, force: { type: "boolean" } },
      allowPositionals: true,
      strict: true,
    });
    if (parsed.positionals.length !== 1) {
      throw new Error("Usage: wr merge <name> [--into <target>] [--force]");
    }

    const repo = new Repo(process.cwd());
    const name = parsed.positionals[0];
    process.chdir(repo.primary);

    const deferred = repo.locked(() => merge(repo, name, parsed.values.into, parsed.values.force ?? false));
    if (deferred) {
      deferTabCleanup(repo, name);
    }
  } else if (command === "rm") {
    const parsed = parseArgs({
      args: args.slice(1),
      options: { force: { type: "boolean" }, "keep-branch": { type: "boolean", short: "k" }, verbose: { type: "boolean" } },
      allowPositionals: true,
      strict: true,
    });
    if (parsed.positionals.length !== 1) {
      throw new Error("Usage: wr rm <name> [--force] [--keep-branch] [--verbose]");
    }

    const repo = new Repo(process.cwd());
    const name = parsed.positionals[0];
    process.chdir(repo.primary);

    const verbose = parsed.values.verbose ?? false;
    const deferredName = repo.locked(() => {
      const registeredName = repo.entryByNameOrBranch(name).branch;
      const deferred = remove(repo, registeredName, {
        force: parsed.values.force, keepBranch: parsed.values["keep-branch"], verbose,
      });
      return deferred ? registeredName : null;
    });
    if (deferredName) {
      deferTabCleanup(repo, deferredName, verbose);
    }
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
}
