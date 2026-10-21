import { object, text } from "./config";

export function gh(cwd: string, args: string[]): string {
  if (!Bun.which("gh")) {
    throw new Error("wr add --pr requires GitHub CLI (gh). Install it and run gh auth login.");
  }
  const result = Bun.spawnSync(["gh", ...args], {
    cwd,
    // Resolve the repository from this checkout, not an inherited override.
    env: { ...process.env, GH_REPO: "", GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", GIT_MERGE_AUTOEDIT: "no" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const error = result.stderr.toString().trim() || `gh ${args.join(" ")} failed`;
    if (error.includes("unknown flag: --worktree")) {
      throw new Error("Upgrade GitHub CLI (gh): wr add --pr requires gh pr checkout --worktree support.");
    }
    throw new Error(error);
  }
  return result.stdout.toString();
}

export function pullRequest(cwd: string, number: string) {
  if (!/^[1-9]\d*$/.test(number) || !Number.isSafeInteger(Number(number))) {
    throw new Error("--pr must be a positive GitHub PR number");
  }
  const pr = object(JSON.parse(gh(cwd, ["pr", "view", number, "--json", "headRefName,headRefOid"])), "GitHub PR");
  const branch = text(pr.headRefName, "PR headRefName");
  const head = text(pr.headRefOid, "PR headRefOid");
  if (!/^[0-9a-f]{40}$/.test(head)) {
    throw new Error("Invalid GitHub PR head commit");
  }
  return { number, branch, head };
}
