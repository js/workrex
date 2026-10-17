import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { Repo } from "./repo";
import { add, list } from "./workrex";
import { deferTabCleanup, merge, remove } from "./lifecycle";

export async function run(args: string[]) {
  if (process.env.WR_LUA) process.env.WR_LUA = resolve(process.env.WR_LUA);
  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    console.log("Usage: wr add <name> [--branch <source>]\n       wr merge <name> [--into <target>] [--force]\n       wr rm <name> [--force]\n       wr ls");
    return;
  }
  const command = args[0];
  if (command === "ls" || command === "list") {
    if (args.length !== 1) throw new Error("Usage: wr ls");
    list(new Repo(process.cwd()));
  } else if (command === "add") {
    const parsed = parseArgs({ args: args.slice(1), options: { branch: { type: "string" } }, allowPositionals: true, strict: true });
    if (parsed.positionals.length !== 1) throw new Error("Usage: wr add <name> [--branch <source>]");
    const repo = new Repo(process.cwd());
    repo.locked(() => add(repo, parsed.positionals[0], parsed.values.branch));
  } else if (command === "merge") {
    const parsed = parseArgs({ args: args.slice(1), options: { into: { type: "string" }, force: { type: "boolean" } }, allowPositionals: true, strict: true });
    if (parsed.positionals.length !== 1) throw new Error("Usage: wr merge <name> [--into <target>] [--force]");
    const repo = new Repo(process.cwd());
    const name = parsed.positionals[0];
    process.chdir(repo.primary);
    const deferred = repo.locked(() => merge(repo, name, parsed.values.into, parsed.values.force ?? false));
    if (deferred) deferTabCleanup(repo, name);
  } else if (command === "rm") {
    const parsed = parseArgs({ args: args.slice(1), options: { force: { type: "boolean" } }, allowPositionals: true, strict: true });
    if (parsed.positionals.length !== 1) throw new Error("Usage: wr rm <name> [--force]");
    const repo = new Repo(process.cwd());
    const name = parsed.positionals[0];
    process.chdir(repo.primary);
    const deferred = repo.locked(() => remove(repo, name, parsed.values.force ?? false));
    if (deferred) deferTabCleanup(repo, name);
  } else throw new Error(`Unknown command: ${command}`);
}
