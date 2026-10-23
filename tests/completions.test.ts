import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executable, fixture } from "./helpers";

let f: ReturnType<typeof fixture>;
beforeEach(() => {
  f = fixture();
  symlinkSync(executable, join(f.root, "bin", "wr"));
});
afterEach(() => {
  f.dispose();
});

function add(name: string) {
  const result = f.wr(["add", name]);
  expect(result.code).toBe(0);
  expect(result.err).toBe("");
  return f.path(name);
}

function lines(text: string) {
  return text.split("\n").filter((line) => line.length > 0);
}

function fish(line: string, cwd = f.primary) {
  const script = f.wr(["completions", "fish"], f.root);
  expect(script.code).toBe(0);
  expect(script.err).toBe("");
  const path = join(f.root, "completion.fish");
  writeFileSync(path, script.out);
  const result = f.command(
    ["fish", "--no-config", "-c", 'source "$WR_FISH"; source "$WR_FISH"; complete -C "$WR_LINE"'],
    cwd,
    { WR_FISH: path, WR_LINE: line },
  );
  expect(result.code).toBe(0);
  expect(result.err).toBe("");
  return lines(result.out);
}

test("completions fish is a constant script with no repo names", () => {
  add("feat/x");
  add("a$b;c");
  add("q'u");
  const outside = f.wr(["completions", "fish"], f.root);
  const inside = f.wr(["completions", "fish"]);
  expect(outside.code).toBe(0);
  expect(outside.err).toBe("");
  expect(outside.out.endsWith("\n")).toBe(true);
  expect(outside.out).toBe(inside.out);
  for (const name of ["feat/x", "a$b;c", "q'u", "main", f.primary]) {
    expect(outside.out).not.toContain(name);
  }
  expect(outside.out).not.toContain("git");
  const path = join(f.root, "completion.fish");
  writeFileSync(path, outside.out);
  const syntax = f.command(["fish", "--no-config", "-n", path], f.root);
  expect(syntax.code).toBe(0);
  expect(syntax.err).toBe("");

  const help = f.wr(["--help"], f.root);
  const documented = [...new Set([...help.out.matchAll(/^  wr ([a-z]+)/gm)].map((match) => match[1]))];
  expect(documented).toEqual(["add", "open", "merge", "rm", "ls", "config", "completions"]);
  expect(fish("wr ", f.root).sort()).toEqual([...documented, "list"].sort());
});

test("fish completes command options without treating worktree names as commands", () => {
  add("merge");
  expect(fish("wr add --")).toEqual(["--branch", "--pr"]);
  expect(fish("wr add merge --")).toEqual(["--branch", "--pr"]);
  expect(fish("wr merge --")).toEqual(["--into", "--force"]);
  expect(fish("wr merge merge --")).toEqual(["--into", "--force"]);
  expect(fish("wr open merge --")).toEqual([]);
  expect(fish("wr rm --")).toEqual(["--force", "--keep-branch", "--verbose"]);
  expect(fish("wr ls --")).toEqual(["--verbose"]);
  expect(fish("wr list --")).toEqual(["--verbose"]);
  expect(fish("wr ls -- --")).toEqual([]);
  expect(fish("wr add -- --")).toEqual([]);
  expect(fish("wr add --pr --")).toEqual([]);
  expect(fish("wr rm --branch ")).toEqual([]);
  expect(fish("wr add --into ")).toEqual([]);
});

test("fish automatically loads the documented wr.fish one-liner", () => {
  add("review/topic");
  const path = join(f.xdg, "fish/completions/wr.fish");
  f.write(path, "wr completions fish | source\n");
  const result = f.command(["fish", "-c", 'complete -C "wr open review/"']);
  expect(result.code).toBe(0);
  expect(result.err).toBe("");
  expect(lines(result.out)).toEqual(["review/topic"]);
});

test("rejects completions other than fish", () => {
  for (const args of [["completions"], ["completions", "bash"], ["completions", "fish", "extra"], ["completions", "zsh"]]) {
    const result = f.wr(args, f.root);
    expect(result.code).toBe(1);
    expect(result.out).toBe("");
    expect(result.err).toBe("wr: Usage: wr completions fish\n");
  }
});

test("silent name query outside git, on a bad registry, and for an unknown kind", () => {
  const state = join(f.primary, ".git/workrex/state.json");
  mkdirSync(join(f.primary, ".git/workrex"));
  writeFileSync(state, "{");
  const before = readFileSync(state);
  for (const [args, cwd] of [
    [["__complete", "registered"], f.root],
    [["__complete", "open"], f.root],
    [["__complete", "branches"], f.root],
    [["__complete"], f.root],
    [["__complete", "registered", "extra"], f.root],
    [["__complete", "registered"], f.primary],
    [["__complete", "nope"], f.primary],
    [["__complete", "fish"], f.primary],
  ] as const) {
    const result = f.wr([...args], cwd);
    expect(result).toEqual({ code: 0, out: "", err: "" });
  }
  expect(readFileSync(state)).toEqual(before);
  expect(existsSync(join(f.primary, ".git/workrex/lock"))).toBe(false);
  expect(existsSync(f.env.WR_FAKE_STORE)).toBe(false);
});

test("fish completion uses registered names, open extras, and branch refs", () => {
  add("feat/x");
  add("a$b;c");
  add("q'u");
  add("merge");
  const switched = add("alias");
  f.git(["switch", "-c", "live"], switched);
  const missing = add("gone");
  rmSync(missing, { recursive: true, force: true });

  const outside = join(f.root, "outside");
  f.git(["worktree", "add", "-b", "merge-ext", outside, "HEAD"]);
  const detached = join(f.root, "detached");
  f.git(["worktree", "add", "--detach", detached, "HEAD"]);
  const locked = join(f.root, "locked");
  f.git(["worktree", "add", "-b", "locked-b", locked, "HEAD"]);
  f.git(["worktree", "lock", locked]);
  const absent = join(f.root, "absent");
  f.git(["worktree", "add", "-b", "absent-b", absent, "HEAD"]);
  rmSync(absent, { recursive: true, force: true });
  const brokenReal = join(f.root, "broken-real");
  f.git(["worktree", "add", "-b", "broken-b", brokenReal, "HEAD"]);
  rmSync(brokenReal, { recursive: true, force: true });
  symlinkSync(join(f.root, "missing-target"), brokenReal);
  f.git(["branch", "other"]);
  f.git(["tag", "other"]);

  const statePath = join(f.primary, ".git/workrex/state.json");
  const stateBefore = readFileSync(statePath);
  const tabsBefore = readFileSync(f.env.WR_FAKE_STORE);
  expect(existsSync(join(f.primary, ".git/workrex/lock"))).toBe(false);

  const registered = ["feat/x", "a$b;c", "q'u", "merge", "alias", "gone"];
  expect(fish("wr rm ")).toEqual(registered);
  expect(fish("wr rm ", switched)).toEqual(registered);
  expect(fish("wr add ")).toEqual(registered);
  expect(fish("wr merge ")).toEqual(registered);
  expect(fish("wr rm feat/x ")).toEqual([]);
  expect(fish("wr rm -")).toEqual(["--force", "--keep-branch", "--verbose"]);
  expect(fish("wr rm --force ")).toEqual(registered);
  expect(fish("wr rm --keep-branch ")).toEqual(registered);
  expect(fish("wr rm -k ")).toEqual(registered);
  expect(fish("wr rm --verbose ")).toEqual(registered);
  expect(fish("wr rm feat/x -")).toEqual(["--force", "--keep-branch", "--verbose"]);
  expect(fish("wr rm -- ")).toEqual(registered);
  expect(fish("wr rm -- -")).toEqual([]);
  expect(fish("wr rm merge")).toEqual(["merge"]);
  expect(fish("wr open ")).toEqual([...registered, "merge-ext"]);
  expect(fish("wr open ", outside)).toEqual([...registered, "merge-ext"]);
  expect(fish("wr open ")).not.toContain("main");
  expect(fish("wr open ")).not.toContain("live");
  expect(fish("wr open ")).not.toContain("locked-b");
  expect(fish("wr open ")).not.toContain("absent-b");
  expect(fish("wr open ")).not.toContain("broken-b");

  const heads = [...registered, "live", "merge-ext", "locked-b", "absent-b", "broken-b", "main", "other"].sort();
  expect(fish("wr merge feat/x --into ")).toEqual(heads);
  expect(heads).toContain("main");
  expect(fish("wr add --branch ")).toEqual(heads);
  expect(fish("wr add --branch ")).toContain("other");
  expect(fish("wr add --branch other ")).toEqual(registered);
  expect(fish("wr add --pr ")).toEqual([]);
  expect(fish("wr add --pr 830")).toEqual([]);
  expect(fish("wr add --pr ")).not.toContain("tracked.txt");

  expect(f.wr(["__complete", "registered"]).out).toBe(registered.join("\n") + "\n");
  expect(readFileSync(statePath)).toEqual(stateBefore);
  expect(readFileSync(f.env.WR_FAKE_STORE)).toEqual(tabsBefore);
  expect(existsSync(join(f.primary, ".git/workrex/lock"))).toBe(false);
  expect(f.git(["worktree", "list", "--porcelain"])).toContain("broken-b");
});
