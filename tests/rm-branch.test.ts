import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executable, fixture } from "./helpers";

let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(() => { f.dispose(); });

function switched() {
  expect(f.wr(["add", "task"]).code).toBe(0);
  const path = f.path("task");
  f.git(["switch", "-c", "fix/security"], path);
  return path;
}

function commit(path: string) {
  f.write(join(path, "new.txt"), "work\n");
  f.git(["add", "new.txt"], path);
  f.git(["commit", "-m", "Work"], path);
  return f.git(["rev-parse", "HEAD"], path);
}

function branch(name: string) {
  return f.command(["git", "show-ref", "--verify", `refs/heads/${name}`]).code === 0;
}

function savePlan(keepBranch = false) {
  const state = f.state();
  state.entries[0].phase = "removing";
  state.entries[0].expectedHead = f.git(["rev-parse", "HEAD"], f.path("task"));
  state.entries[0].force = true;
  state.entries[0].removal = { branch: "fix/security", keepBranch };
  state.version = 2;
  writeFileSync(join(f.primary, ".git/workrex/state.json"), JSON.stringify(state));
}

test.each(["task", "fix/security"])("rm %s deletes only the current branch", (name) => {
  const path = switched();
  const original = f.git(["rev-parse", "task"]);

  const result = f.wr(["rm", name, "--verbose"]);

  expect(result.code).toBe(0);
  expect(result.err).toBe("");
  expect(result.out).toContain("Deleting branch: fix/security\nDeleted branch: fix/security\n");
  expect(result.out).not.toContain("Deleted branch: task");
  expect(result.out).toContain("Removed task.\n");
  expect(existsSync(path)).toBe(false);
  expect(branch("fix/security")).toBe(false);
  expect(f.git(["rev-parse", "task"])).toBe(original);
  expect(f.state().entries).toEqual([]);
  expect(f.tabs()).toEqual([]);
});

test("rm accepts a renamed branch after the original ref disappeared", () => {
  expect(f.wr(["add", "task"]).code).toBe(0);
  f.git(["branch", "-m", "fix/security"], f.path("task"));
  expect(branch("task")).toBe(false);
  expect(f.wr(["rm", "task"]).code).toBe(0);
  expect(branch("fix/security")).toBe(false);
});

test("registered name wins over branch lookup and leaves the original branch's other checkout intact", () => {
  const path = switched();
  const other = join(f.root, "original-checkout");
  f.git(["worktree", "add", other, "task"]);
  const original = commit(other);

  const result = f.wr(["rm", "task"]);

  expect(result.code).toBe(0);
  expect(result.err).toBe("");
  expect(existsSync(path)).toBe(false);
  expect(existsSync(other)).toBe(true);
  expect(f.git(["rev-parse", "task"])).toBe(original);
  expect(branch("fix/security")).toBe(false);
});

test("rm checks the current branch for unmerged commits and leaves the registry unchanged on refusal", () => {
  const path = switched();
  const head = commit(path);
  const state = f.state();

  const result = f.wr(["rm", "task"]);

  expect(result.code).toBe(1);
  expect(result.err).toContain("fix/security has commits not merged into main");
  expect(f.state()).toEqual(state);
  expect(f.git(["rev-parse", "fix/security"])).toBe(head);
  expect(existsSync(path)).toBe(true);
});

test.each(["--keep-branch", "-k"])("rm %s preserves an unmerged current branch without confirmation", (flag) => {
  const path = switched();
  const head = commit(path);

  const result = f.wr(["rm", "task", flag]);

  expect(result.code).toBe(0);
  expect(result.err).toBe("");
  expect(result.out).toContain("Kept branch: fix/security\n");
  expect(result.out).not.toContain("Deleted branch:");
  expect(f.git(["rev-parse", "fix/security"])).toBe(head);
  expect(branch("task")).toBe(true);
  expect(existsSync(path)).toBe(false);
});

test.each([false, true])("dirty switched work still requires --force (keepBranch=%s)", (keepBranch) => {
  const path = switched();
  f.write(join(path, "tracked.txt"), "dirty\n");
  const flags = keepBranch ? ["--keep-branch"] : [];

  const refused = f.wr(["rm", "task", ...flags]);
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("Worktree is dirty");
  expect(readFileSync(join(path, "tracked.txt"), "utf8")).toBe("dirty\n");

  expect(f.wr(["rm", "task", "--force", ...flags]).code).toBe(0);
  expect(existsSync(path)).toBe(false);
  expect(branch("task")).toBe(true);
  expect(branch("fix/security")).toBe(keepBranch);
});

test.each([{ flags: [] }, { flags: ["--force"] }, { flags: ["--keep-branch", "--force"] }])("rm protects a checkout switched to the default branch: $flags", ({ flags }) => {
  const path = switched();
  f.git(["switch", "--ignore-other-worktrees", "main"], path);
  const result = f.wr(["rm", "task", ...flags]);
  expect(result.code).toBe(1);
  expect(result.err).toContain("Refusing to remove the default branch");
  expect(existsSync(path)).toBe(true);
  expect(branch("main")).toBe(true);
});

test("rm handles detached HEAD without deleting either named branch", () => {
  const path = switched();
  f.git(["switch", "--detach", "HEAD"], path);
  expect(f.wr(["rm", "task"]).code).toBe(0);
  expect(existsSync(path)).toBe(false);
  expect(branch("task")).toBe(true);
  expect(branch("fix/security")).toBe(true);
});

test("--keep-branch does not silently abandon unmerged detached commits", () => {
  const path = switched();
  f.git(["switch", "--detach", "HEAD"], path);
  commit(path);
  const result = f.wr(["rm", "task", "--keep-branch"]);
  expect(result.code).toBe(1);
  expect(result.err).toContain("Detached HEAD has commits not merged");
  expect(existsSync(path)).toBe(true);
});

test("retry remembers the deletion target after its worktree is gone", () => {
  const path = switched();
  const lock = join(f.primary, ".git/refs/heads/fix/security.lock");
  f.write(lock, "");
  const failed = f.wr(["rm", "task"]);
  expect(failed.code).toBe(1);
  expect(existsSync(path)).toBe(false);
  expect(f.state().version).toBe(2);
  expect(f.state().entries[0].branch).toBe("task");
  expect(f.state().entries[0].removal).toEqual({ branch: "fix/security", keepBranch: false });

  rmSync(lock);
  const result = f.wr(["rm", "task"]);
  expect(result.code).toBe(0);
  expect(result.out).toContain("Deleted branch: fix/security");
  expect(branch("fix/security")).toBe(false);
  expect(branch("task")).toBe(true);
});

test("retry refuses to delete a current branch that advanced after the directory was removed", () => {
  switched();
  const lock = join(f.primary, ".git/refs/heads/fix/security.lock");
  f.write(lock, "");
  expect(f.wr(["rm", "task"]).code).toBe(1);
  rmSync(lock);
  const newHead = commit(f.primary);
  f.git(["update-ref", "refs/heads/fix/security", newHead]);

  const refused = f.wr(["rm", "task", "--force"]);
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("Source branch changed after cleanup began");
  expect(f.git(["rev-parse", "fix/security"])).toBe(newHead);
  expect(branch("task")).toBe(true);
  expect(f.wr(["rm", "task", "--keep-branch"]).code).toBe(0);
  expect(f.git(["rev-parse", "fix/security"])).toBe(newHead);
});

test("retry after tab failure ignores changes to the preserved original branch", () => {
  switched();
  expect(f.wr(["rm", "task"], f.primary, { WR_FAKE_FAIL: "wr_close" }).code).toBe(1);
  const newHead = commit(f.primary);
  f.git(["update-ref", "refs/heads/task", newHead]);

  const result = f.wr(["rm", "task"]);
  expect(result.code).toBe(0);
  expect(result.out).toContain("Branch already removed: fix/security");
  expect(f.git(["rev-parse", "task"])).toBe(newHead);
});

test.each([false, true])("retry preserves a saved keep-branch decision (repeatFlag=%s)", (repeatFlag) => {
  switched();
  expect(f.wr(["rm", "task", "--keep-branch"], f.primary, { WR_FAKE_FAIL: "wr_close" }).code).toBe(1);
  expect(f.state().entries[0].removal.keepBranch).toBe(true);
  expect(f.wr(["rm", "task", ...(repeatFlag ? ["--keep-branch"] : [])]).code).toBe(0);
  expect(branch("fix/security")).toBe(true);
  expect(branch("task")).toBe(true);
});

test("a retry can preserve rather than delete a branch, but never retargets it", () => {
  switched();
  const lock = join(f.primary, ".git/refs/heads/fix/security.lock");
  f.write(lock, "");
  expect(f.wr(["rm", "task"]).code).toBe(1);
  rmSync(lock);
  expect(f.wr(["rm", "task", "--keep-branch"]).code).toBe(0);
  expect(branch("fix/security")).toBe(true);
  expect(branch("task")).toBe(true);
});

test.each(["branch", "head"])("retry refuses a worktree whose %s changed after cleanup started", (change) => {
  const path = switched();
  savePlan(true);
  if (change === "branch") f.git(["switch", "task"], path);
  else commit(path);
  const result = f.wr(["rm", "task", "--force"]);
  expect(result.code).toBe(1);
  expect(result.err).toContain(`Worktree ${change === "head" ? "HEAD" : "branch"} changed after cleanup began`);
  expect(existsSync(path)).toBe(true);
  expect(branch("task")).toBe(true);
  expect(branch("fix/security")).toBe(true);
});

test("missing-directory cleanup uses the saved current branch", () => {
  const path = switched();
  savePlan();
  rmSync(path, { recursive: true });
  expect(f.wr(["rm", "task"]).code).toBe(0);
  expect(branch("task")).toBe(true);
  expect(branch("fix/security")).toBe(false);
});

test("current-branch lookup defers cleanup under the stable registered name", async () => {
  const path = switched();
  const result = f.wr(["rm", "fix/security", "--keep-branch"], path, { REX_BLOCK: f.tabs()[0].block_id });
  expect(result.code).toBe(0);
  const log = join(f.primary, ".git/workrex/cleanup.log");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && (!readFileSync(log, "utf8").endsWith("Removed task.\n") || existsSync(join(f.primary, ".git/workrex/lock")))) {
    await Bun.sleep(50);
  }
  expect(readFileSync(log, "utf8")).toContain("Kept branch: fix/security");
  expect(f.state().entries).toEqual([]);
  expect(f.tabs()).toEqual([]);
  expect(branch("task")).toBe(true);
  expect(branch("fix/security")).toBe(true);
});

test.each(["y", "n", "", null])("unmerged removal requires an affirmative interactive answer: %j", (answer) => {
  const path = switched();
  commit(path);
  const preload = join(f.root, "confirmation.ts");
  f.write(preload, `Object.defineProperty(process.stdin, "isTTY", { value: true });\nglobalThis.prompt = (question) => { console.log(question); return ${JSON.stringify(answer)}; };\n`);
  const result = f.command([process.execPath, "--preload", preload, executable, "rm", "task"]);
  expect(result.code).toBe(0);
  expect(result.out).toContain("fix/security has commits not merged into main.");
  expect(result.out).toContain("delete branch fix/security? [y/N]");
  expect(existsSync(path)).toBe(answer !== "y");
  expect(branch("fix/security")).toBe(answer !== "y");
  expect(branch("task")).toBe(true);
  if (answer !== "y") {
    expect(result.out).toContain("Aborted.");
    expect(f.state().entries[0].phase).toBe("ready");
  }
});

test.each([
  { plan: { keepBranch: false } },
  { plan: { branch: "fix/security", keepBranch: "false" } },
  { plan: null },
])("malformed removal plans are refused before cleanup: $plan", ({ plan }) => {
  const path = switched();
  savePlan();
  const state = f.state();
  state.entries[0].removal = plan;
  writeFileSync(join(f.primary, ".git/workrex/state.json"), JSON.stringify(state));
  expect(f.wr(["rm", "task", "--force"]).code).toBe(1);
  expect(existsSync(path)).toBe(true);
  expect(branch("task")).toBe(true);
  expect(branch("fix/security")).toBe(true);
});

test("confirmation does not authorize commits or branch switches made while prompting", () => {
  const path = switched();
  commit(path);
  const preload = join(f.root, "confirmation.ts");
  f.write(preload, `Object.defineProperty(process.stdin, "isTTY", { value: true });\nglobalThis.prompt = () => { Bun.spawnSync(["git", "-C", ${JSON.stringify(path)}, "switch", "task"]); return "y"; };\n`);
  const result = f.command([process.execPath, "--preload", preload, executable, "rm", "task"]);
  expect(result.code).toBe(1);
  expect(result.err).toContain("Worktree branch changed after cleanup began");
  expect(existsSync(path)).toBe(true);
  expect(branch("fix/security")).toBe(true);
});
