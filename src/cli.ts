import { parseArgs } from "node:util";
import { Repo } from "./repo";
import { add, list } from "./workrex";

export async function run(args: string[]) {
  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    console.log("Usage: wr add <name> [--branch <source>]\n       wr ls");
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
  } else throw new Error(`Unknown command: ${command}`);
}
