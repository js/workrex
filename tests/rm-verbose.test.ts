import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./helpers";

let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(() => { f.dispose(); });

function add() {
  expect(f.wr(["add", "feature"]).code).toBe(0);
  return f.path("feature");
}

test.each([false, true])("rm --verbose announces operations before completion (force=%s)", (force) => {
  const path = add();
  if (force) f.write(join(path, "tracked.txt"), "discard\n");

  const result = f.wr(["rm", "--verbose", "feature", ...(force ? ["--force"] : [])]);

  expect(result).toEqual({
    code: 0,
    err: "",
    out: [
      `Verifying worktree: ${path}`,
      "Resolving default branch",
      "Resolving branch: feature",
      "Inspecting tab: feature",
      ...(!force ? [
        `Checking for unfinished Git operations: ${path}`,
        `Checking for uncommitted changes: ${path}`,
        "Checking feature is merged into main",
      ] : []),
      "Recording removal: feature",
      "Checking removal state: feature",
      `Inspecting worktree: ${path}`,
      `Verifying worktree: ${path}`,
      `Removing worktree: ${path}`,
      `Removed worktree: ${path}`,
      "Checking branch checkouts: feature",
      "Deleting branch: feature",
      "Deleted branch: feature",
      "Inspecting tab: feature",
      "Closing tab: feature",
      "Closed tab: feature",
      "Removing registration: feature",
      "Removed registration: feature",
      "Removed feature.",
    ].join("\n") + "\n",
  });
  expect(existsSync(path)).toBe(false);
  expect(f.state().entries).toEqual([]);
  expect(f.tabs()).toEqual([]);
});

test("rm --verbose shows a failing safety check without starting removal", () => {
  const path = add();
  f.write(join(path, "tracked.txt"), "keep\n");
  const state = f.state();

  const result = f.wr(["rm", "feature", "--verbose"]);

  expect(result.code).toBe(1);
  expect(result.err).toContain("Worktree is dirty");
  expect(result.out).toBe([
    `Verifying worktree: ${path}`,
    "Resolving default branch",
    "Resolving branch: feature",
    "Inspecting tab: feature",
    `Checking for unfinished Git operations: ${path}`,
    `Checking for uncommitted changes: ${path}`,
  ].join("\n") + "\n");
  expect(readFileSync(join(path, "tracked.txt"), "utf8")).toBe("keep\n");
  expect(f.state()).toEqual(state);
});

test("rm --verbose announces a failed deletion and skips already removed resources on retry", () => {
  const path = add();
  const lock = join(f.primary, ".git/refs/heads/feature.lock");
  f.write(lock, "");

  const result = f.wr(["rm", "feature", "--verbose"]);

  expect(result.code).toBe(1);
  expect(result.out.endsWith("Deleting branch: feature\n")).toBe(true);
  expect(result.out).not.toContain("Deleted branch:");
  expect(result.out).not.toContain("Closing tab:");
  expect(existsSync(path)).toBe(false);
  expect(f.state().entries[0].phase).toBe("removing");

  rmSync(lock);
  const retried = f.wr(["rm", "feature", "--verbose"]);
  expect(retried).toEqual({
    code: 0,
    err: "",
    out: [
      "Checking removal state: feature",
      `Inspecting worktree: ${path}`,
      `Worktree already removed: ${path}`,
      "Checking branch checkouts: feature",
      "Deleting branch: feature",
      "Deleted branch: feature",
      "Inspecting tab: feature",
      "Closing tab: feature",
      "Closed tab: feature",
      "Removing registration: feature",
      "Removed registration: feature",
      "Removed feature.",
    ].join("\n") + "\n",
  });
});

test("rm --verbose announces external tab closure before it fails, without deleting Git resources", () => {
  const path = join(f.root, "external");
  f.git(["worktree", "add", "-b", "ext", path]);
  expect(f.wr(["open", "ext"]).code).toBe(0);

  const result = f.wr(["rm", "ext", "--verbose"], f.primary, { WR_FAKE_FAIL: "wr_close" });

  expect(result.code).toBe(1);
  expect(result.out).toBe("Inspecting tab: ext\nClosing tab: ext\n");
  expect(existsSync(path)).toBe(true);
  expect(f.state().entries[0].phase).toBe("external");
  expect(f.tabs()).toHaveLength(1);

  const retried = f.wr(["rm", "ext", "--verbose"]);
  expect(retried).toEqual({
    code: 0,
    err: "",
    out: [
      "Inspecting tab: ext",
      "Closing tab: ext",
      "Closed tab: ext",
      "Removing registration: ext",
      "Removed registration: ext",
      "Closed ext. wr did not create this worktree, so it and its branch remain.",
    ].join("\n") + "\n",
  });
  expect(existsSync(path)).toBe(true);
  expect(f.git(["rev-parse", "ext"])).toBe(f.git(["rev-parse", "main"]));
});

test("rm --verbose announces metadata cleanup and confirms an already closed tab", () => {
  const path = add();
  const state = f.state();
  state.entries[0].phase = "removing";
  state.entries[0].expectedHead = f.git(["rev-parse", "feature"]);
  writeFileSync(join(f.primary, ".git/workrex/state.json"), JSON.stringify(state));
  rmSync(path, { recursive: true });
  const store = JSON.parse(readFileSync(f.env.WR_FAKE_STORE, "utf8"));
  store.tabs = [];
  writeFileSync(f.env.WR_FAKE_STORE, JSON.stringify(store));

  const result = f.wr(["rm", "feature", "--verbose"]);

  expect(result.code).toBe(0);
  expect(result.err).toBe("");
  expect(result.out).toContain(`Removing worktree metadata: ${path}\nRemoved worktree metadata: ${path}\n`);
  expect(result.out).toContain("Confirming tab is closed: feature\nTab already closed: feature\n");
  expect(result.out).not.toContain("Closing tab:");
  expect(f.state().entries).toEqual([]);
});

test("rm --verbose propagates to deferred cleanup without prematurely claiming tab closure", async () => {
  const path = add();
  const log = join(f.primary, ".git/workrex/cleanup.log");
  const result = f.wr(["rm", "feature", "--verbose"], path, { REX_BLOCK: f.tabs()[0].block_id });

  expect(result.code).toBe(0);
  expect(result.err).toBe("");
  expect(result.out).toContain("Starting background tab cleanup: feature\nClosing this tab in the background.");
  expect(result.out).not.toContain("Closing tab:");
  expect(result.out).not.toContain("Removing registration:");
  expect(existsSync(path)).toBe(false);

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && (
    !readFileSync(log, "utf8").endsWith("Removed feature.\n") ||
    existsSync(join(f.primary, ".git/workrex/lock"))
  )) {
    await Bun.sleep(50);
  }

  expect(readFileSync(log, "utf8")).toBe([
    "Checking removal state: feature",
    `Inspecting worktree: ${path}`,
    `Worktree already removed: ${path}`,
    "Branch already removed: feature",
    "Inspecting tab: feature",
    "Closing tab: feature",
    "Closed tab: feature",
    "Removing registration: feature",
    "Removed registration: feature",
    "Removed feature.",
  ].join("\n") + "\n");
  expect(f.state().entries).toEqual([]);
  expect(f.tabs()).toEqual([]);
});

test("rm --verbose still requires exactly one name and takes no value", () => {
  for (const args of [["--verbose"], ["--verbose", "one", "two"], ["one", "--verbose=false"]]) {
    const result = f.wr(["rm", ...args], f.root);
    expect(result.code).toBe(1);
    expect(result.out).toBe("");
    if (!args.includes("--verbose=false")) {
      expect(result.err).toBe("wr: Usage: wr rm <name> [--force] [--keep-branch] [--verbose]\n");
    }
  }
});
