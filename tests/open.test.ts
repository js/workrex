import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./helpers";

let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(() => { f.dispose(); });

function external(name: string) {
  const path = join(f.root, name);
  f.git(["worktree", "add", "-b", name, path]);
  return path;
}

function registration() {
  const path = join(f.primary, ".git/workrex/state.json");
  if (!existsSync(path)) {
    return [];
  }
  return JSON.parse(readFileSync(path, "utf8")).entries;
}

function branch(name: string) {
  return f.command(["git", "show-ref", "--verify", `refs/heads/${name}`]).code === 0;
}

test("open accepts exactly one branch name", () => {
  for (const args of [["open"], ["open", "a", "b"], ["open", "--force"], ["open", "ext", "extra"]]) {
    const result = f.wr(args);
    expect(result.code).toBe(1);
    expect(result.err).toBe("wr: Usage: wr open <name>\n");
    expect(result.out).toBe("");
  }
  expect(f.wr(["--help"]).out).toContain("wr open <name>");
  expect(registration()).toEqual([]);
});

test("open registers an existing worktree and builds panes from project config", () => {
  f.global({ panes: [{ command: ["global-pane"] }] });
  f.local({ panes: [
    { command: ["project-pane"] },
    { command: ["project-two"], split: "horizontal", percentage: 30, focus: true },
  ] });
  const path = external("ext");

  const result = f.wr(["open", "ext"]);

  expect(result.err).toBe("");
  expect(result.code).toBe(0);
  expect(result.out).toBe(`ext\t${path}\topen\n`);
  expect(f.tabs()).toHaveLength(1);
  expect(f.tabs()[0].cwd).toBe(path);
  expect(f.tabs()[0].label).toBe("project space/ext");
  expect(f.tabs()[0].panes).toEqual([
    { command: ["project-pane"], focus: false },
    { command: ["project-two"], focus: true, parent: 1, split: "horizontal", percentage: 30 },
  ]);
  expect(f.state().entries[0].phase).toBe("external");
  expect(f.wr(["ls"]).out).toContain(`ext\topen\texternal\t${path}`);
});

test("repeat open focuses the tab, and a closed tab rebuilds from current project panes", () => {
  f.global({ panes: [{ command: ["global-pane"] }] });
  f.local({ panes: [{ command: ["project-pane"] }] });
  const path = external("ext");
  expect(f.wr(["open", "ext"]).code).toBe(0);
  const first = f.tabs()[0].window_id;

  expect(f.wr(["open", "ext"]).code).toBe(0);
  expect(f.tabs()).toHaveLength(1);
  expect(f.tabs()[0].window_id).toBe(first);
  expect(f.tabs()[0].panes).toEqual([{ command: ["project-pane"], focus: false }]);

  const store = JSON.parse(readFileSync(f.env.WR_FAKE_STORE, "utf8"));
  store.tabs = [];
  writeFileSync(f.env.WR_FAKE_STORE, JSON.stringify(store));
  f.global({ panes: [{ command: ["global-later"] }] });
  f.local({ panes: [
    { command: ["project-later"] },
    { command: ["side"], split: "vertical", percentage: 25 },
  ] });

  expect(f.wr(["open", "ext"]).code).toBe(0);
  expect(f.tabs()).toHaveLength(1);
  expect(f.tabs()[0].window_id).not.toBe(first);
  expect(f.tabs()[0].cwd).toBe(path);
  expect(f.tabs()[0].panes).toEqual([
    { command: ["project-later"], focus: false },
    { command: ["side"], focus: false, parent: 1, split: "vertical", percentage: 25 },
  ]);
});

test("open does not apply file rules or change existing worktree files", () => {
  f.local({ files: { copy: [".env"], symlink: ["secret.txt"] } });
  f.write(join(f.primary, ".env"), "primary-env\n");
  f.write(join(f.primary, "secret.txt"), "secret\n");
  const path = external("ext");
  f.write(join(path, "tracked.txt"), "local edit\n");
  f.write(join(path, "notes.txt"), "keep\n");

  expect(f.wr(["open", "ext"]).code).toBe(0);

  expect(readFileSync(join(path, "tracked.txt"), "utf8")).toBe("local edit\n");
  expect(readFileSync(join(path, "notes.txt"), "utf8")).toBe("keep\n");
  expect(existsSync(join(path, ".env"))).toBe(false);
  expect(existsSync(join(path, "secret.txt"))).toBe(false);
});

test("open of an unknown branch writes nothing", () => {
  const result = f.wr(["open", "nope"]);

  expect(result.code).toBe(1);
  expect(result.err).toContain("No worktree has branch nope. Create one with wr add nope");
  expect(registration()).toEqual([]);
  expect(existsSync(f.path("nope"))).toBe(false);
  expect(branch("nope")).toBe(false);
  expect(existsSync(f.env.WR_FAKE_STORE)).toBe(false);
});

test("open refuses the primary checkout, a locked worktree, and a missing directory", () => {
  const primary = f.wr(["open", "main"]);
  expect(primary.code).toBe(1);
  expect(primary.err).toContain("Refusing protected or locked worktree");
  expect(registration()).toEqual([]);

  const locked = external("locked");
  f.git(["worktree", "lock", locked]);
  const lockedResult = f.wr(["open", "locked"]);
  expect(lockedResult.code).toBe(1);
  expect(lockedResult.err).toContain("Refusing protected or locked worktree");
  expect(registration()).toEqual([]);
  expect(existsSync(locked)).toBe(true);

  const gone = external("gone");
  rmSync(gone, { recursive: true });
  const missing = f.wr(["open", "gone"]);
  expect(missing.code).toBe(1);
  expect(missing.err).toContain(`Worktree is missing: ${gone}`);
  expect(registration()).toEqual([]);
  expect(existsSync(f.env.WR_FAKE_STORE)).toBe(false);
  expect(branch("locked")).toBe(true);
  expect(branch("gone")).toBe(true);
});

test("invalid project panes fail open before registration or a tab", () => {
  f.local({ panes: [{ id: "editor", command: ["nvim"] }, { command: ["pi"], split_from: "agent" }] });
  const path = external("ext");

  const result = f.wr(["open", "ext"]);

  expect(result.code).toBe(1);
  expect(result.err).toContain("split_from");
  expect(registration()).toEqual([]);
  expect(existsSync(f.env.WR_FAKE_STORE)).toBe(false);
  expect(existsSync(path)).toBe(true);
  expect(branch("ext")).toBe(true);
});

test("rm --force of an external worktree closes only the tab", () => {
  const path = external("ext");
  expect(f.wr(["open", "ext"]).code).toBe(0);
  f.write(join(path, "tracked.txt"), "dirty tracked\n");
  f.write(join(path, "untracked.txt"), "dirty untracked\n");
  f.write(join(path, "ignored/output"), "dirty ignored\n");

  const result = f.wr(["rm", "ext", "--force"]);

  expect(result.err).toBe("");
  expect(result.code).toBe(0);
  expect(result.out).toContain("Closed ext. wr did not create this worktree, so it and its branch remain.");
  expect(readFileSync(join(path, "tracked.txt"), "utf8")).toBe("dirty tracked\n");
  expect(readFileSync(join(path, "untracked.txt"), "utf8")).toBe("dirty untracked\n");
  expect(readFileSync(join(path, "ignored/output"), "utf8")).toBe("dirty ignored\n");
  expect(existsSync(path)).toBe(true);
  expect(branch("ext")).toBe(true);
  expect(f.tabs()).toEqual([]);
  expect(f.state().entries).toEqual([]);
});

test("merge --force refuses an external worktree before Git", () => {
  const path = external("ext");
  expect(f.wr(["open", "ext"]).code).toBe(0);
  f.write(join(path, "tracked.txt"), "keep\n");
  const head = f.git(["rev-parse", "ext"]);
  const entry = f.state().entries[0];

  const result = f.wr(["merge", "ext", "--force"]);

  expect(result.code).toBe(1);
  expect(result.err).toContain(
    "wr did not create ext, so it will not merge or delete it. Merge with Git, then run wr rm ext to close its tab.",
  );
  expect(readFileSync(join(path, "tracked.txt"), "utf8")).toBe("keep\n");
  expect(f.git(["rev-parse", "ext"])).toBe(head);
  expect(existsSync(path)).toBe(true);
  expect(f.state().entries).toEqual([entry]);
  expect(f.tabs()).toHaveLength(1);
});

test("rm from the external tab defers cleanup, then drops the entry and tab", async () => {
  const path = external("ext");
  expect(f.wr(["open", "ext"]).code).toBe(0);
  const result = f.wr(["rm", "ext"], f.primary, { REX_BLOCK: f.tabs()[0].block_id });

  expect(result.code).toBe(0);
  expect(result.out).toContain("Closing this tab in the background");
  expect(result.out).not.toContain("Git cleanup complete");

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && (registration().length > 0 || f.tabs().length > 0)) {
    await Bun.sleep(50);
  }

  expect(registration()).toEqual([]);
  expect(f.tabs()).toEqual([]);
  expect(existsSync(path)).toBe(true);
  expect(branch("ext")).toBe(true);
});

test("a failed tab close keeps the external entry for a retry", () => {
  const path = external("ext");
  expect(f.wr(["open", "ext"]).code).toBe(0);

  const failed = f.wr(["rm", "ext"], f.primary, { WR_FAKE_FAIL: "wr_close" });
  expect(failed.code).toBe(1);
  expect(f.state().entries[0].phase).toBe("external");
  expect(f.tabs()).toHaveLength(1);
  expect(existsSync(path)).toBe(true);
  expect(branch("ext")).toBe(true);

  const retried = f.wr(["rm", "ext"]);
  expect(retried.err).toBe("");
  expect(retried.code).toBe(0);
  expect(f.state().entries).toEqual([]);
  expect(f.tabs()).toEqual([]);
  expect(existsSync(path)).toBe(true);
  expect(branch("ext")).toBe(true);
});

test("rm drops a stale external entry after the directory is pruned", () => {
  const path = external("ext");
  expect(f.wr(["open", "ext"]).code).toBe(0);
  rmSync(path, { recursive: true });
  f.git(["worktree", "prune"]);

  const result = f.wr(["rm", "ext"]);

  expect(result.err).toBe("");
  expect(result.code).toBe(0);
  expect(f.state().entries).toEqual([]);
  expect(f.tabs()).toEqual([]);
  expect(branch("ext")).toBe(true);
});

test("add focuses an opened worktree and points unmanaged branches at open", () => {
  f.git(["worktree", "add", "-b", "unmanaged", join(f.root, "unmanaged")]);
  const refused = f.wr(["add", "unmanaged"]);
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("unmanaged worktree");
  expect(refused.err).toContain("wr open unmanaged");
  expect(registration()).toEqual([]);

  external("ext");
  expect(f.wr(["open", "ext"]).code).toBe(0);
  const windowId = f.tabs()[0].window_id;

  const again = f.wr(["add", "ext"]);
  expect(again.err).toBe("");
  expect(again.code).toBe(0);
  expect(f.tabs()).toHaveLength(1);
  expect(f.tabs()[0].window_id).toBe(windowId);

  const retarget = f.wr(["add", "ext", "--branch", "main"]);
  expect(retarget.code).toBe(1);
  expect(retarget.err).toContain("--branch cannot be used with an existing wr worktree");
  expect(f.tabs()).toHaveLength(1);
  expect(f.tabs()[0].window_id).toBe(windowId);
});

test("open preserves managed ownership and inherits global panes from a linked checkout", () => {
  f.global({ panes: [{ command: ["global-pane"] }] });
  f.local({ main_branch: "main" });
  expect(f.wr(["add", "owned"]).code).toBe(0);
  const path = f.path("owned");
  f.write(join(path, ".workrex.json"), JSON.stringify({ panes: [{ command: ["wrong-checkout"] }] }));
  const store = JSON.parse(readFileSync(f.env.WR_FAKE_STORE, "utf8"));
  store.tabs = [];
  writeFileSync(f.env.WR_FAKE_STORE, JSON.stringify(store));

  const result = f.wr(["open", "owned"], path);

  expect(result.err).toBe("");
  expect(result.code).toBe(0);
  expect(f.state().entries[0].phase).toBe("ready");
  expect(f.tabs()).toHaveLength(1);
  expect(f.tabs()[0].cwd).toBe(path);
  expect(f.tabs()[0].panes).toEqual([{ command: ["global-pane"], focus: false }]);
});

test("open reopens a switched external worktree by its registered name without registering the path twice", () => {
  const path = external("ext");
  expect(f.wr(["open", "ext"]).code).toBe(0);
  const entry = f.state().entries[0];
  const windowId = f.tabs()[0].window_id;
  f.git(["switch", "-c", "different"], path);

  const again = f.wr(["open", "ext"]);
  expect(again.err).toBe("");
  expect(again.code).toBe(0);
  expect(again.out).toBe(`ext\t${path}\topen\n`);
  expect(f.tabs()).toHaveLength(1);
  expect(f.tabs()[0].window_id).toBe(windowId);
  expect(f.tabs()[0].cwd).toBe(path);
  expect(f.git(["branch", "--show-current"], path)).toBe("different");
  expect(f.state().entries).toEqual([entry]);

  const result = f.wr(["open", "different"]);
  expect(result.code).toBe(1);
  expect(result.err).toContain(`${path} is already registered as ext`);
  expect(f.state().entries).toEqual([entry]);
  expect(f.tabs()).toHaveLength(1);
  expect(f.git(["branch", "--show-current"], path)).toBe("different");
});

test("open reopens a switched managed worktree by its registered name without moving Git state", () => {
  const name = "investigate-sentry-ELTON-APP-3D8";
  expect(f.wr(["add", name]).code).toBe(0);
  const path = f.path(name);
  f.write(join(path, "tracked.txt"), "dirty tracked\n");
  f.write(join(path, "untracked.txt"), "dirty untracked\n");
  const head = f.git(["rev-parse", "HEAD"], path);
  f.git(["switch", "-c", "fix/apple-pay-cancellation"], path);
  const entry = f.state().entries[0];
  const store = JSON.parse(readFileSync(f.env.WR_FAKE_STORE, "utf8"));
  store.tabs = [];
  writeFileSync(f.env.WR_FAKE_STORE, JSON.stringify(store));

  const result = f.wr(["open", name]);

  expect(result.err).toBe("");
  expect(result.code).toBe(0);
  expect(result.out).toBe(`${name}\t${path}\topen\n`);
  expect(f.tabs()).toHaveLength(1);
  expect(f.tabs()[0].cwd).toBe(path);
  const reopened = f.state().entries[0];
  expect(f.state().entries).toHaveLength(1);
  expect(reopened.branch).toBe(name);
  expect(reopened.phase).toBe("ready");
  expect(reopened.path).toBe(entry.path);
  expect(reopened.gitDir).toBe(entry.gitDir);
  expect(reopened.identity).toBe(entry.identity);
  expect(f.git(["rev-parse", "HEAD"], path)).toBe(head);
  expect(f.git(["branch", "--show-current"], path)).toBe("fix/apple-pay-cancellation");
  expect(readFileSync(join(path, "tracked.txt"), "utf8")).toBe("dirty tracked\n");
  expect(readFileSync(join(path, "untracked.txt"), "utf8")).toBe("dirty untracked\n");

  const removed = f.wr(["rm", name, "--force"]);
  expect(removed.code).toBe(1);
  expect(removed.err).toContain(`Worktree no longer has branch ${name}`);
  const merged = f.wr(["merge", name, "--force"]);
  expect(merged.code).toBe(1);
  expect(merged.err).toContain(`Worktree no longer has branch ${name}`);
  expect(existsSync(path)).toBe(true);
  expect(f.git(["rev-parse", "HEAD"], path)).toBe(head);
  expect(f.git(["branch", "--show-current"], path)).toBe("fix/apple-pay-cancellation");
  expect(readFileSync(join(path, "tracked.txt"), "utf8")).toBe("dirty tracked\n");
  expect(readFileSync(join(path, "untracked.txt"), "utf8")).toBe("dirty untracked\n");
  expect(f.state().entries).toHaveLength(1);
  expect(f.state().entries[0].branch).toBe(name);
  expect(f.state().entries[0].phase).toBe("ready");
  expect(f.tabs()).toHaveLength(1);
});

test("open refuses a worktree whose directory identity changed", () => {
  expect(f.wr(["add", "feature"]).code).toBe(0);
  const path = f.path("feature");
  const state = f.state();
  state.entries[0].identity = "replaced";
  writeFileSync(join(f.primary, ".git/workrex/state.json"), JSON.stringify(state));
  const before = f.state().entries;
  const head = f.git(["rev-parse", "HEAD"], path);
  f.write(join(path, "tracked.txt"), "keep\n");

  const result = f.wr(["open", "feature"]);

  expect(result.code).toBe(1);
  expect(result.err).toContain(`Worktree identity changed: ${path}`);
  expect(f.state().entries).toEqual(before);
  expect(f.git(["rev-parse", "HEAD"], path)).toBe(head);
  expect(f.git(["branch", "--show-current"], path)).toBe("feature");
  expect(readFileSync(join(path, "tracked.txt"), "utf8")).toBe("keep\n");
  expect(f.tabs()).toHaveLength(1);
  expect(existsSync(path)).toBe(true);
});

test("unconfirmed open tells you to close the tab manually", () => {
  external("ext");

  const result = f.wr(["open", "ext"], f.primary, { WR_FAKE_FAIL: "open-after" });

  expect(result.code).toBe(1);
  expect(result.err).toContain("close that tab manually before retrying.");
  expect(result.err).not.toContain("wr add");
  expect(registration()).toEqual([]);
  expect(f.tabs()).toHaveLength(1);
});
