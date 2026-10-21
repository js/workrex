import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture } from "./helpers";

let f: ReturnType<typeof fixture>;
let pr: { branch: string; head: string; remote: string };
let metadata: string;

beforeEach(() => {
  f = fixture();
  symlinkSync(resolve(import.meta.dir, "fake-gh"), join(f.root, "bin/gh"));
  metadata = join(f.root, "pr.json");
  const remote = join(f.root, "pr remote");
  // The PR commit exists only in the remote, not in the invoking repository.
  f.git(["clone", "--quiet", f.primary, remote]);
  f.write(join(remote, "pr.txt"), "PR content\n");
  f.git(["add", "."], remote);
  f.git(["commit", "-m", "PR change"], remote);
  const head = f.git(["rev-parse", "HEAD"], remote);
  f.git(["update-ref", "refs/pull/830/head", head], remote);
  pr = { branch: "feature/pr-review", head, remote };
  savePR();
});
afterEach(() => { f.dispose(); });

function savePR() {
  writeFileSync(metadata, JSON.stringify(pr));
}
function wr(args = ["add", "--pr", "830"], cwd = f.primary, overrides: Record<string, string> = {}) {
  return f.wr(args, cwd, { WR_FAKE_PR: metadata, ...overrides });
}
function calls(): { args: string[]; cwd: string; repo: string }[] {
  return existsSync(`${metadata}.calls`)
    ? readFileSync(`${metadata}.calls`, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    : [];
}
function expectNoCreation() {
  expect(f.git(["worktree", "list", "--porcelain"]).match(/^worktree /gm)).toHaveLength(1);
  expect(f.command(["git", "show-ref", "--verify", `refs/heads/${pr.branch}`]).code).not.toBe(0);
  expect(existsSync(f.path(pr.branch))).toBe(false);
  if (existsSync(f.env.WR_FAKE_STORE)) expect(f.tabs()).toEqual([]);
  const state = join(f.primary, ".git/workrex/state.json");
  if (existsSync(state)) expect(f.state().entries).toEqual([]);
}

test("--pr fetches the PR into a managed worktree and applies the merged Workrex config", () => {
  const originalHead = f.git(["rev-parse", "HEAD"]);
  f.write(join(f.primary, "tracked.txt"), "dirty primary\n");
  f.write(join(f.primary, ".env"), "primary env\n");
  f.write(join(f.primary, "secret.txt"), "primary secret\n");
  f.global({ panes: [{ command: ["sh"] }], files: { symlink: ["secret.txt"] } });
  f.local({ files: { copy: [".env"] } });
  const status = f.git(["status", "--porcelain"]);

  const result = wr(undefined, f.primary, { GH_REPO: "wrong/repository" });
  expect(result.err).toBe("");
  expect(result.code).toBe(0);
  const path = f.path(pr.branch);
  expect(result.out).toContain(`${pr.branch}\t${path}\topen`);
  expect(f.git(["rev-parse", "HEAD"], path)).toBe(pr.head);
  expect(f.git(["branch", "--show-current"], path)).toBe(pr.branch);
  expect(readFileSync(join(path, "pr.txt"), "utf8")).toBe("PR content\n");
  expect(readFileSync(join(path, ".env"), "utf8")).toBe("primary env\n");
  expect(readlinkSync(join(path, "secret.txt"))).toBe(join(f.primary, "secret.txt"));
  expect(f.tabs()).toHaveLength(1);
  expect(f.tabs()[0].cwd).toBe(path);
  expect(f.tabs()[0].label).toBe(`project space/${pr.branch}`);
  expect(f.tabs()[0].panes).toEqual([{ command: ["sh"], focus: false }]);
  expect(f.state().entries[0].phase).toBe("ready");
  expect(f.state().entries[0].gitDir).toBeTruthy();
  expect(f.git(["branch", "--show-current"])).toBe("main");
  expect(f.git(["rev-parse", "HEAD"])).toBe(originalHead);
  expect(f.git(["status", "--porcelain"])).toBe(status);
  expect(calls()).toEqual([
    { args: ["pr", "view", "830", "--json", "headRefName,headRefOid"], cwd: f.primary, repo: "" },
    { args: ["pr", "checkout", "830", "--branch", pr.branch, "--worktree", path], cwd: f.primary, repo: "" },
  ]);
});

test("--pr works from a linked checkout and uses primary-checkout config", () => {
  const linked = join(f.root, "linked");
  f.git(["worktree", "add", "-b", "linked", linked]);
  f.local({ panes: [{ command: "primary-command" }] });
  f.write(join(linked, ".workrex.json"), "invalid config");
  const result = wr(undefined, linked);
  expect(result.err).toBe("");
  expect(result.code).toBe(0);
  expect(f.git(["branch", "--show-current"], linked)).toBe("linked");
  expect(f.git(["rev-parse", "HEAD"], f.path(pr.branch))).toBe(pr.head);
  expect(f.tabs()[0].panes).toEqual([{ command: "primary-command", focus: false }]);
});

test("an explicit name lets a fork PR use a different local branch name", () => {
  pr.branch = "main";
  savePR();
  const initial = f.git(["rev-parse", "main"]);
  const result = wr(["add", "review-830", "--pr=830"]);
  expect(result.err).toBe("");
  expect(result.code).toBe(0);
  expect(f.git(["rev-parse", "HEAD"], f.path("review-830"))).toBe(pr.head);
  expect(f.git(["branch", "--show-current"], f.path("review-830"))).toBe("review-830");
  expect(f.git(["rev-parse", "main"])).toBe(initial);
});

test("repeating --pr reuses or reopens the tab without resetting local work or reapplying files", () => {
  f.local({ files: { copy: [".env"] } });
  f.write(join(f.primary, ".env"), "primary\n");
  expect(wr().code).toBe(0);
  const path = f.path(pr.branch);
  f.write(join(path, "local.txt"), "local commit\n");
  f.git(["add", "local.txt"], path);
  f.git(["commit", "-m", "Local work"], path);
  const localHead = f.git(["rev-parse", "HEAD"], path);
  f.write(join(path, "tracked.txt"), "dirty worktree\n");
  f.write(join(path, ".env"), "worktree\n");

  expect(wr().code).toBe(0);
  expect(f.tabs()).toHaveLength(1);
  const store = JSON.parse(readFileSync(f.env.WR_FAKE_STORE, "utf8"));
  store.tabs = [];
  writeFileSync(f.env.WR_FAKE_STORE, JSON.stringify(store));
  expect(wr().code).toBe(0);
  expect(f.tabs()).toHaveLength(1);
  expect(f.git(["rev-parse", "HEAD"], path)).toBe(localHead);
  expect(readFileSync(join(path, "tracked.txt"), "utf8")).toBe("dirty worktree\n");
  expect(readFileSync(join(path, ".env"), "utf8")).toBe("worktree\n");
  expect(calls().filter((call) => call.args[1] === "checkout")).toHaveLength(1);
});

test.each(["", "0", "-1", "1.2", "abc", "830;echo bad", "https://github.com/owner/repo/pull/830", "9007199254740992"])(
  "--pr rejects a non-positive-integer selector: %s", (number) => {
    const result = wr(["add", `--pr=${number}`]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("positive GitHub PR number");
    expect(calls()).toEqual([]);
    expectNoCreation();
  },
);

test.each([
  { args: ["add", "--pr"] },
  { args: ["add", "one", "two", "--pr", "830"] },
  { args: ["add", "--pr", "830", "--branch", "main"] },
  { args: ["add", "named", "--pr", "830", "--branch", "main"] },
])("invalid --pr arguments fail before calling gh: $args", ({ args }) => {
  expect(wr([...args]).code).toBe(1);
  expect(calls()).toEqual([]);
  expectNoCreation();
});

test("an existing local branch is never moved by --pr", () => {
  f.git(["branch", pr.branch]);
  const head = f.git(["rev-parse", pr.branch]);
  const result = wr();
  expect(result.code).toBe(1);
  expect(result.err).toContain("already exists");
  expect(f.git(["rev-parse", pr.branch])).toBe(head);
  expect(calls()).toHaveLength(1);
  expect(existsSync(f.path(pr.branch))).toBe(false);
});

test("unmanaged worktrees and path collisions are preserved", () => {
  const path = join(f.root, "unmanaged");
  f.git(["worktree", "add", "-b", pr.branch, path]);
  expect(wr().err).toContain("unmanaged worktree");
  expect(calls()).toHaveLength(1);
  expect(f.git(["branch", "--show-current"], path)).toBe(pr.branch);

  pr.branch = "path-collision";
  savePR();
  f.write(f.path(pr.branch), "keep me");
  expect(wr().err).toContain("path already exists");
  expect(readFileSync(f.path(pr.branch), "utf8")).toBe("keep me");
  expect(calls()).toHaveLength(2);
});

test.each(["-bad", "../escape", "HEAD", "bad name"])("PR branch metadata is validated: %s", (branch) => {
  pr.branch = branch;
  savePR();
  const result = wr();
  expect(result.code).toBe(1);
  expect(result.err).toContain("Invalid branch name");
  expect(calls()).toHaveLength(1);
  expect(existsSync(f.env.WR_FAKE_STORE)).toBe(false);
});

test("PR branch names are passed literally, not through a shell", () => {
  pr.branch = "semi;colon";
  savePR();
  expect(wr().code).toBe(0);
  expect(f.git(["branch", "--show-current"], f.path(pr.branch))).toBe(pr.branch);
});

test.each(["view", "invalid-json", "checkout-before", "checkout-after-fetch", "old-gh"])(
  "gh failure before worktree creation leaves no managed worktree: %s", (failure) => {
    const result = wr(undefined, f.primary, { WR_FAKE_GH_FAIL: failure });
    expect(result.code).toBe(1);
    if (failure === "old-gh") expect(result.err).toContain("Upgrade GitHub CLI");
    if (failure === "view") expect(result.err).toContain("authentication failed");
    expectNoCreation();
    expect(wr().code).toBe(0);
  },
);

test("a nonexistent PR fails without local changes", () => {
  const result = wr(["add", "--pr", "999"]);
  expect(result.code).toBe(1);
  expect(result.err).toContain("Could not resolve");
  expectNoCreation();
});

test("missing gh reports installation instructions without creating a worktree", () => {
  const bin = join(f.root, "no-gh");
  mkdirSync(bin);
  for (const command of ["bun", "git"]) symlinkSync(Bun.which(command)!, join(bin, command));
  const result = wr(undefined, f.primary, { PATH: bin });
  expect(result.code).toBe(1);
  expect(result.err).toContain("requires GitHub CLI");
  expectNoCreation();
});

test.each(["config", "files", "session"])("invalid preflight %s prevents gh checkout", (failure) => {
  if (failure === "config") f.local({ panes: [] });
  if (failure === "files") f.local({ files: { copy: ["../escape"] } });
  const result = wr(undefined, f.primary, failure === "session" ? { REX_SESSION: "" } : {});
  expect(result.code).toBe(1);
  expect(calls()).toHaveLength(1);
  expectNoCreation();
});

test("failure after gh creates the worktree keeps a removable incomplete registration", () => {
  const result = wr(undefined, f.primary, { WR_FAKE_GH_FAIL: "checkout-after-tree" });
  expect(result.code).toBe(1);
  expect(result.err).toContain("failed after worktree creation");
  expect(f.state().entries[0].phase).toBe("creating");
  expect(f.state().entries[0].gitDir).toBeTruthy();
  expect(wr().err).toContain("unfinished creating");
  expect(f.wr(["rm", pr.branch, "--force"]).code).toBe(0);
  expectNoCreation();
});

test("a failed file rule retains the PR worktree for inspection and cleanup", () => {
  f.local({ files: { copy: ["tracked.txt"] } });
  expect(wr().err).toContain("destination already exists");
  expect(f.state().entries[0].phase).toBe("creating");
  expect(f.git(["rev-parse", "HEAD"], f.path(pr.branch))).toBe(pr.head);
  expect(wr().err).toContain("unfinished creating");
  expect(f.wr(["rm", pr.branch, "--force"]).code).toBe(0);
  expectNoCreation();
});

test("Rex failure leaves a ready PR worktree that can be reopened without another checkout", () => {
  expect(wr(undefined, f.primary, { WR_FAKE_FAIL: "wr_open" }).code).toBe(1);
  expect(f.state().entries[0].phase).toBe("ready");
  expect(wr().code).toBe(0);
  expect(f.tabs()).toHaveLength(1);
  expect(calls().filter((call) => call.args[1] === "checkout")).toHaveLength(1);
});

test("a missing PR worktree is not silently recreated", () => {
  expect(wr().code).toBe(0);
  rmSync(f.path(pr.branch), { recursive: true });
  expect(wr().err).toContain("missing");
  expect(calls().filter((call) => call.args[1] === "checkout")).toHaveLength(1);
});
