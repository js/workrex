import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./helpers";

let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(() => { f.dispose(); });

function add(name = "feature", source?: string) {
  const result = f.wr(["add", name, ...(source ? ["--branch", source] : [])]);
  expect(result.code).toBe(0);
  return f.path(name);
}

function commit(path: string, file = "feature.txt", content = "feature\n") {
  f.write(join(path, file), content);
  f.git(["add", "--", file], path);
  f.git(["commit", "-m", "Feature"], path);
}

function ok(args: string[], cwd = f.primary) {
  const result = f.wr(args, cwd);
  expect(result.err).toBe("");
  expect(result.code).toBe(0);
  return result;
}

test("merge rebases onto the default branch, fast-forwards, and removes all owned resources", () => {
  const path = add();
  commit(path);
  commit(f.primary, "main.txt", "main\n");
  const previous = f.git(["rev-parse", "main"]);

  const result = ok(["merge", "feature"]);

  expect(result.out).toBe([
    "Rebased feature onto main and fast-forwarded main.",
    `Removed worktree: ${path}`,
    "Deleted branch: feature",
    "Closed tab: feature",
    "Removed registration: feature",
    "Removed feature.",
  ].join("\n") + "\n");
  expect(f.git(["rev-parse", "main^"])).toBe(previous);
  expect(readFileSync(join(f.primary, "feature.txt"), "utf8")).toBe("feature\n");
  expect(existsSync(path)).toBe(false);
  expect(f.command(["git", "show-ref", "--verify", "refs/heads/feature"]).code).not.toBe(0);
  expect(f.state().entries).toEqual([]);
  expect(f.tabs()).toEqual([]);
});

test("merge into an unchecked-out branch does not switch the primary checkout", () => {
  f.git(["branch", "target"]);
  const path = add();
  commit(path);
  const main = f.git(["rev-parse", "main"]);

  const result = ok(["merge", "feature", "--into", "target"]);

  expect(result.out).toBe([
    "Rebased feature onto target and fast-forwarded target.",
    `Removed worktree: ${path}`,
    "Deleted branch: feature",
    "Closed tab: feature",
    "Removed registration: feature",
    "Removed feature.",
  ].join("\n") + "\n");
  expect(f.git(["branch", "--show-current"])).toBe("main");
  expect(f.git(["rev-parse", "main"])).toBe(main);
  expect(f.git(["show", "target:feature.txt"])).toBe("feature");
});

test("add source does not change the default merge target", () => {
  f.git(["branch", "source"]);
  const path = add("feature", "source");
  commit(path);
  const source = f.git(["rev-parse", "source"]);

  ok(["merge", "feature"]);

  expect(f.git(["rev-parse", "source"])).toBe(source);
  expect(f.git(["show", "main:feature.txt"])).toBe("feature");
});

test("merge checks the actual target checkout, never discarding its changes", () => {
  const path = add();
  commit(path);
  const targetPath = join(f.root, "target");
  f.git(["worktree", "add", "-b", "target", targetPath]);
  f.write(join(targetPath, "untracked.txt"), "keep");
  f.write(join(path, "tracked.txt"), "also keep");

  const result = f.wr(["merge", "feature", "--into", "target", "--force"]);

  expect(result.err).toContain("Target checkout is dirty");
  expect(readFileSync(join(path, "tracked.txt"), "utf8")).toBe("also keep");
  expect(readFileSync(join(targetPath, "untracked.txt"), "utf8")).toBe("keep");
  expect(f.tabs()).toHaveLength(1);
});

test.each(["staged", "unstaged", "untracked"])("merge refuses %s changes", (kind) => {
  const path = add();
  const file = kind === "untracked" ? "new.txt" : "tracked.txt";
  f.write(join(path, file), "keep\n");
  if (kind === "staged") {
    f.git(["add", file], path);
  }
  f.git(["config", "status.showUntrackedFiles", "no"]);

  const result = f.wr(["merge", "feature"]);

  expect(result.err).toContain("Worktree is dirty");
  expect(readFileSync(join(path, file), "utf8")).toBe("keep\n");
  expect(f.tabs()).toHaveLength(1);
});

test("merge --force discards changes without a commit or stash", () => {
  const path = add();
  commit(path);
  const head = f.git(["rev-parse", "feature"]);
  f.write(join(path, "tracked.txt"), "staged\n");
  f.git(["add", "tracked.txt"], path);
  f.write(join(path, "tracked.txt"), "unstaged\n");
  f.write(join(path, "new.txt"), "discard\n");
  f.write(join(path, "ignored/output"), "ignored\n");

  ok(["merge", "feature", "--force"]);

  expect(f.git(["rev-parse", "main"])).toBe(head);
  expect(f.git(["stash", "list"])).toBe("");
  expect(readFileSync(join(f.primary, "tracked.txt"), "utf8")).toBe("initial\n");
  expect(existsSync(join(f.primary, "new.txt"))).toBe(false);
  expect(existsSync(path)).toBe(false);
});

function conflict() {
  const path = add();
  commit(path, "tracked.txt", "feature version\n");
  commit(f.primary, "tracked.txt", "main version\n");
  return path;
}

test("conflicts leave the rebase and tab intact, and force does not abort an existing rebase", () => {
  const path = conflict();
  f.write(join(path, "ignored/output"), "keep ignored\n");
  f.write(join(path, "untracked.txt"), "discard\n");

  const result = f.wr(["merge", "feature", "--force"]);
  expect(result.err).toContain("Rebase stopped");
  expect(existsSync(join(path, "untracked.txt"))).toBe(false);
  expect(readFileSync(join(path, "ignored/output"), "utf8")).toBe("keep ignored\n");
  expect(f.tabs()).toHaveLength(1);
  expect(f.state().entries[0].phase).toBe("ready");

  f.write(join(path, "tracked.txt"), "resolved\n");
  f.git(["add", "tracked.txt"], path);
  expect(f.wr(["merge", "feature", "--force"]).err).toContain("unfinished rebase");
  expect(readFileSync(join(path, "tracked.txt"), "utf8")).toBe("resolved\n");

  f.git(["-c", "core.editor=true", "rebase", "--continue"], path);
  ok(["merge", "feature"]);
  expect(readFileSync(join(f.primary, "tracked.txt"), "utf8")).toBe("resolved\n");
});

test("merge --force refuses an unfinished merge, but rm --force abandons it", () => {
  const path = conflict();
  expect(f.command(["git", "merge", "main"], path).code).not.toBe(0);

  expect(f.wr(["merge", "feature", "--force"]).err).toContain("unfinished merge");
  expect(f.wr(["rm", "feature"]).err).toContain("unfinished merge");

  ok(["rm", "feature", "--force"]);
  expect(existsSync(path)).toBe(false);
  expect(f.tabs()).toEqual([]);
});

test("rm refuses unmerged or dirty work, while force abandons a paused rebase", () => {
  const path = conflict();
  expect(f.wr(["rm", "feature"]).err).toContain("not merged");

  f.write(join(path, "dirty.txt"), "keep\n");
  expect(f.wr(["rm", "feature"]).err).toContain("dirty");

  expect(f.wr(["merge", "feature", "--force"]).err).toContain("Rebase stopped");
  ok(["rm", "feature", "--force"]);
  expect(existsSync(path)).toBe(false);
  expect(f.state().entries).toEqual([]);
});

test("rm reports each completed step for a clean branch already merged into main", () => {
  const path = add();

  const result = ok(["rm", "feature"]);

  expect(result.out).toBe([
    `Removed worktree: ${path}`,
    "Deleted branch: feature",
    "Closed tab: feature",
    "Removed registration: feature",
    "Removed feature.",
  ].join("\n") + "\n");
  expect(existsSync(path)).toBe(false);
  expect(f.tabs()).toEqual([]);
});

test("rm --force can clean up failed file setup", () => {
  f.local({ files: { copy: ["tracked.txt"] } });
  expect(f.wr(["add", "failed"]).code).toBe(1);

  const result = ok(["rm", "failed", "--force"]);

  expect(result.out).toBe([
    `Removed worktree: ${f.path("failed")}`,
    "Deleted branch: failed",
    "Tab already closed: failed",
    "Removed registration: failed",
    "Removed failed.",
  ].join("\n") + "\n");
  expect(f.state().entries).toEqual([]);
  expect(existsSync(f.path("failed"))).toBe(false);
});

test.each(["merge", "rm"])("%s closes only the saved window ID, regardless of tab titles", (action) => {
  add();
  const store = JSON.parse(readFileSync(f.env.WR_FAKE_STORE, "utf8"));
  const other = { ...store.tabs[0], window_id: "window:unrelated", block_id: "block:unrelated" };
  store.tabs[0].label = "Renamed work tab";
  store.tabs.unshift(other);
  writeFileSync(f.env.WR_FAKE_STORE, JSON.stringify(store));

  ok([action, "feature"]);

  expect(f.tabs()).toEqual([other]);
  expect(f.state().entries).toEqual([]);
});

test.each(["merge", "rm"])("%s reports completed Git cleanup but not a failed tab closure", (action) => {
  const path = add();
  commit(path);

  const result = f.wr([action, "feature", ...(action === "rm" ? ["--force"] : [])], f.primary, { WR_FAKE_FAIL: "wr_close" });
  expect(result.code).toBe(1);
  expect(result.out).toBe([
    ...(action === "merge" ? ["Rebased feature onto main and fast-forwarded main."] : []),
    `Removed worktree: ${path}`,
    "Deleted branch: feature",
  ].join("\n") + "\n");
  expect(existsSync(path)).toBe(false);
  expect(f.state().entries[0].phase).toBe("removing");
  expect(f.tabs()).toHaveLength(1);

  const retried = ok(["rm", "feature"]);
  expect(retried.out).toBe([
    `Worktree already removed: ${path}`,
    "Branch already removed: feature",
    "Closed tab: feature",
    "Removed registration: feature",
    "Removed feature.",
  ].join("\n") + "\n");
  expect(f.state().entries).toEqual([]);
  expect(f.tabs()).toEqual([]);
});

test("rm stops reporting progress when branch deletion fails and resumes on retry", () => {
  const path = add();
  const lock = join(f.primary, ".git/refs/heads/feature.lock");
  f.write(lock, "");

  const result = f.wr(["rm", "feature"]);

  expect(result.code).toBe(1);
  expect(result.out).toBe(`Removed worktree: ${path}\n`);
  expect(existsSync(path)).toBe(false);
  expect(f.git(["rev-parse", "feature"])).toBe(f.git(["rev-parse", "main"]));
  expect(f.state().entries[0].phase).toBe("removing");
  expect(f.tabs()).toHaveLength(1);

  rmSync(lock);
  const retried = ok(["rm", "feature"]);
  expect(retried.out).toBe([
    `Worktree already removed: ${path}`,
    "Deleted branch: feature",
    "Closed tab: feature",
    "Removed registration: feature",
    "Removed feature.",
  ].join("\n") + "\n");
  expect(f.state().entries).toEqual([]);
  expect(f.tabs()).toEqual([]);
});

test("rm from its own tab reports Git cleanup and logs deferred completion", async () => {
  const path = add();
  const log = join(f.primary, ".git/workrex/cleanup.log");
  const result = f.wr(["rm", "feature"], path, { REX_BLOCK: f.tabs()[0].block_id });

  expect(result.code).toBe(0);
  expect(result.err).toBe("");
  expect(result.out).toBe([
    `Removed worktree: ${path}`,
    "Deleted branch: feature",
    `Closing this tab in the background. If it stays open, retry wr rm with the same name. Log: ${log}`,
  ].join("\n") + "\n");
  expect(existsSync(path)).toBe(false);

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && (
    !readFileSync(log, "utf8").endsWith("Removed feature.\n") ||
    existsSync(join(f.primary, ".git/workrex/lock"))
  )) {
    await Bun.sleep(50);
  }

  expect(readFileSync(log, "utf8")).toBe([
    `Worktree already removed: ${path}`,
    "Branch already removed: feature",
    "Closed tab: feature",
    "Removed registration: feature",
    "Removed feature.",
  ].join("\n") + "\n");
  expect(f.state().entries).toEqual([]);
  expect(f.tabs()).toEqual([]);
});

test("cleanup resumes after the directory was removed but Git metadata remains", () => {
  const path = add();
  const state = f.state();
  state.entries[0].phase = "removing";
  state.entries[0].expectedHead = f.git(["rev-parse", "feature"]);
  writeFileSync(join(f.primary, ".git/workrex/state.json"), JSON.stringify(state));
  rmSync(path, { recursive: true });

  const result = ok(["rm", "feature"]);

  expect(result.out).toBe([
    `Removed worktree metadata: ${path}`,
    "Deleted branch: feature",
    "Closed tab: feature",
    "Removed registration: feature",
    "Removed feature.",
  ].join("\n") + "\n");
  expect(f.state().entries).toEqual([]);
  expect(f.git(["worktree", "list", "--porcelain"])).not.toContain(path);
  expect(f.tabs()).toEqual([]);
});

test("cleanup refuses a branch that changed after removal began", () => {
  const path = add();
  const state = f.state();
  state.entries[0].phase = "removing";
  state.entries[0].expectedHead = f.git(["rev-parse", "feature"]);
  writeFileSync(join(f.primary, ".git/workrex/state.json"), JSON.stringify(state));
  commit(path);

  const result = f.wr(["rm", "feature", "--force"]);
  expect(result.err).toContain("branch changed");
  expect(result.out).toBe("");
  expect(existsSync(path)).toBe(true);
  expect(f.tabs()).toHaveLength(1);
});

test("mutations refuse an existing repo lock", () => {
  add();
  mkdirSync(join(f.primary, ".git/workrex/lock"));

  expect(f.wr(["rm", "feature", "--force"]).err).toContain("Another wr mutation");
  expect(existsSync(f.path("feature"))).toBe(true);
});

test("merge and rm always require explicit names, even inside their worktree", () => {
  const path = add();
  for (const args of [["merge"], ["rm"], ["merge", "--force"], ["rm", "--force"]]) {
    expect(f.wr(args, path).code).toBe(1);
    expect(existsSync(path)).toBe(true);
  }

  expect(f.wr(["merge", "main"]).code).toBe(1);
  expect(f.wr(["rm", "main", "--force"]).code).toBe(1);
});

test.each(["merge", "rm"])("%s refuses a switched branch before changing data", (action) => {
  const path = add();
  f.git(["switch", "-c", "different"], path);
  f.write(join(path, "tracked.txt"), "keep tracked\n");
  f.write(join(path, "untracked.txt"), "keep untracked\n");
  const state = f.state();
  const tabs = f.tabs();
  const head = f.git(["rev-parse", "HEAD"], path);

  const result = f.wr([action, "feature", "--force"]);

  expect(result.code).toBe(1);
  expect(result.err).toContain("no longer has branch");
  expect(f.state()).toEqual(state);
  expect(f.tabs()).toEqual(tabs);
  expect(f.git(["rev-parse", "HEAD"], path)).toBe(head);
  expect(f.git(["rev-parse", "feature"])).toBe(head);
  expect(f.git(["rev-parse", "main"])).toBe(head);
  expect(f.git(["branch", "--show-current"], path)).toBe("different");
  expect(readFileSync(join(path, "tracked.txt"), "utf8")).toBe("keep tracked\n");
  expect(readFileSync(join(path, "untracked.txt"), "utf8")).toBe("keep untracked\n");
});

test.each(["open", "merge", "rm"])("%s refuses a mismatched Git directory before changing data", (action) => {
  const path = add();
  const state = f.state();
  state.entries[0].gitDir = join(f.primary, ".git/worktrees/other");
  writeFileSync(join(f.primary, ".git/workrex/state.json"), JSON.stringify(state));
  f.write(join(path, "tracked.txt"), "keep tracked\n");
  f.write(join(path, "untracked.txt"), "keep untracked\n");
  const tabs = f.tabs();
  const head = f.git(["rev-parse", "HEAD"], path);

  const result = f.wr([action, "feature", ...(action === "open" ? [] : ["--force"])]);

  expect(result.code).toBe(1);
  expect(result.err).toContain("Worktree ownership changed");
  expect(f.state()).toEqual(state);
  expect(f.tabs()).toEqual(tabs);
  expect(f.git(["rev-parse", "HEAD"], path)).toBe(head);
  expect(f.git(["rev-parse", "feature"])).toBe(head);
  expect(f.git(["rev-parse", "main"])).toBe(head);
  expect(f.git(["branch", "--show-current"], path)).toBe("feature");
  expect(readFileSync(join(path, "tracked.txt"), "utf8")).toBe("keep tracked\n");
  expect(readFileSync(join(path, "untracked.txt"), "utf8")).toBe("keep untracked\n");
});

test("open accepts a directory recreated at the same full worktree path", () => {
  const path = add();
  f.write(join(path, "tracked.txt"), "keep tracked\n");
  f.write(join(path, "untracked.txt"), "keep untracked\n");
  const state = f.state();
  const tabs = f.tabs();
  const head = f.git(["rev-parse", "HEAD"], path);
  const original = join(f.root, "original");
  renameSync(path, original);
  cpSync(original, path, { recursive: true });

  const result = ok(["open", "feature"]);

  expect(result.out).toBe(`feature\t${path}\topen\n`);
  expect(f.state()).toEqual(state);
  expect(f.state().entries[0]).not.toHaveProperty("identity");
  expect(f.tabs()).toEqual(tabs);
  expect(f.git(["rev-parse", "HEAD"], path)).toBe(head);
  expect(f.git(["branch", "--show-current"], path)).toBe("feature");
  expect(readFileSync(join(path, "tracked.txt"), "utf8")).toBe("keep tracked\n");
  expect(readFileSync(join(path, "untracked.txt"), "utf8")).toBe("keep untracked\n");
});
