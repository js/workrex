import { afterEach, beforeEach, expect, test } from "bun:test";
import { fixture } from "./helpers";

let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(() => { f.dispose(); });

test.each([
  { label: "no arguments", args: [] },
  { label: "--help", args: ["--help"] },
  { label: "-h", args: ["-h"] },
])("help describes every command outside a repository: $label", ({ args }) => {
  const result = f.wr([...args], f.root, { REX_SESSION: "" });

  expect(result.code).toBe(0);
  expect(result.err).toBe("");
  expect(result.out).toBe(`Usage: wr <command>

  wr add <name> [--branch <source>]
    Create a worktree and open its Rex tab, or reopen a registered one.
    New branches start at HEAD unless --branch is given.

  wr open <name>
    Focus or reopen a Rex tab for an existing worktree, including one created outside wr.

  wr merge <name> [--into <target>] [--force]
    Rebase onto the default branch or --into target, fast-forward it, then remove
    the worktree, branch, and tab. --force discards uncommitted source changes.

  wr rm <name> [--force]
    Remove a worktree, branch, and tab without merging; --force discards dirty or unmerged work.
    For worktrees created outside wr, only close and unregister the tab.

  wr ls
    List this repo's registered worktrees with their paths, tab status, and state.

  wr config check
    Check global and current-directory .jsonc files for syntax errors, not settings validity.
`);
});
