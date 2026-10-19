import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./helpers";

let f: ReturnType<typeof fixture>;
let globalPath: string;
let projectPath: string;
beforeEach(() => {
  f = fixture();
  globalPath = join(f.xdg, "workrex/config.jsonc");
  projectPath = join(f.primary, ".workrex.jsonc");
});
afterEach(() => { f.dispose(); });

test("config check reports optional missing files and works outside Git without creating files", () => {
  const local = join(f.root, ".workrex.jsonc");
  expect(f.wr(["config", "check"], f.root)).toEqual({
    code: 0,
    out: `Global: ${globalPath}\n  not found (optional)\nProject: ${local}\n  not found (optional)\n`,
    err: "",
  });
  expect(existsSync(f.xdg)).toBe(false);
  expect(existsSync(local)).toBe(false);
  expect(existsSync(f.env.WR_FAKE_STORE)).toBe(false);
});

test("config check accepts JSON, comments, trailing commas, and comment markers in strings", () => {
  f.write(globalPath, '{ "main_branch": "main" }');
  f.write(projectPath, `// Project settings
  {
    /* A block comment. */
    "panes": [{ "command": ["printf", "https://example.test", "/* literal */",], },],
  }`);
  expect(f.wr(["config", "check"])).toEqual({
    code: 0,
    out: `Global: ${globalPath}\n  exists\n  valid JSONC\nProject: ${projectPath}\n  exists\n  valid JSONC\n`,
    err: "",
  });
});

test.each(["global", "project"])("config check reports invalid %s JSONC without skipping the other file", (scope) => {
  f.write(globalPath, scope === "global" ? '{ "panes": }' : "{}");
  f.write(projectPath, scope === "project" ? '{ "panes": }' : "{}");
  const result = f.wr(["config", "check"]);
  expect(result.code).toBe(1);
  expect(result.out).toContain(`Global: ${globalPath}\n  exists\n  ${scope === "global" ? "invalid" : "valid"} JSONC`);
  expect(result.out).toContain(`Project: ${projectPath}\n  exists\n  ${scope === "project" ? "invalid" : "valid"} JSONC`);
  expect(result.err).toContain("Config check failed");
});

test("config check reports both parse errors", () => {
  f.write(globalPath, "{ broken }");
  f.write(projectPath, "{ broken }");
  const result = f.wr(["config", "check"]);
  expect(result.code).toBe(1);
  expect(result.out.match(/invalid JSONC:/g)).toHaveLength(2);
});

test("config check reports a read error and still checks the other file", () => {
  mkdirSync(globalPath, { recursive: true });
  f.write(projectPath, "{}");
  const result = f.wr(["config", "check"]);
  expect(result.code).toBe(1);
  expect(result.out).toContain(`Global: ${globalPath}\n  exists\n  error:`);
  expect(result.out).toContain(`Project: ${projectPath}\n  exists\n  valid JSONC`);
});

test("config check uses ~/.config when XDG_CONFIG_HOME is empty", () => {
  const home = join(f.root, "home");
  const path = join(home, ".config/workrex/config.jsonc");
  f.write(path, "{}");
  f.write(globalPath, "invalid");
  const result = f.wr(["config", "check"], f.primary, { HOME: home, XDG_CONFIG_HOME: "" });
  expect(result.code).toBe(0);
  expect(result.out).toContain(`Global: ${path}\n  exists\n  valid JSONC`);
  expect(result.out).not.toContain(globalPath);
});

test("config check uses the invoking worktree rather than the primary checkout", () => {
  const worktree = join(f.root, "linked");
  f.git(["worktree", "add", "-b", "linked", worktree]);
  f.write(projectPath, "invalid");
  const local = join(worktree, ".workrex.jsonc");
  f.write(local, "{}");
  const result = f.wr(["config", "check"], worktree);
  expect(result.code).toBe(0);
  expect(result.out).toContain(`Project: ${local}\n  exists\n  valid JSONC`);
  expect(result.out).not.toContain(projectPath);
});

test("config check does not search parent directories", () => {
  const cwd = join(f.primary, "nested");
  mkdirSync(cwd);
  f.write(projectPath, "invalid");
  const result = f.wr(["config", "check"], cwd);
  expect(result.code).toBe(0);
  expect(result.out).toContain(`Project: ${join(cwd, ".workrex.jsonc")}\n  not found (optional)`);
});

test("config check only checks JSONC syntax, not Workrex settings", () => {
  f.write(globalPath, '{ "unknown": true }');
  f.write(projectPath, '{ "panes": false }');
  const result = f.wr(["config", "check"]);
  expect(result.code).toBe(0);
  expect(result.out.match(/valid JSONC/g)).toHaveLength(2);
});

test("config check does not fall back to legacy JSON files", () => {
  f.write(join(f.xdg, "workrex/config.json"), "invalid");
  f.write(join(f.primary, ".workrex.json"), "invalid");
  const result = f.wr(["config", "check"]);
  expect(result.code).toBe(0);
  expect(result.out.match(/not found \(optional\)/g)).toHaveLength(2);
});

test.each([
  "config",
  "config unknown",
  "config check extra",
  "config check --unknown",
])("config check rejects invalid arguments: %s", (args) => {
  const result = f.wr(args.split(" "));
  expect(result.code).toBe(1);
  expect(result.err).toContain("Usage: wr config check");
  expect(result.out).toBe("");
});

test("help lists config check", () => {
  expect(f.wr(["--help"]).out).toContain("wr config check");
});
