import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executable, fixture } from "./helpers";

let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(() => { f.dispose(); });

function add(name: string, args: string[] = []) {
  const result = f.wr(["add", name, ...args]);
  expect(result.err).toBe("");
  expect(result.code).toBe(0);
  return f.path(name);
}

test("add creates a worktree and configured tab; repeating add reuses both", () => {
  const path = add("feature/login");
  expect(f.git(["branch", "--show-current"], path)).toBe("feature/login");
  expect(f.tabs()).toHaveLength(1);
  expect(f.tabs()[0].cwd).toBe(path);
  expect(f.tabs()[0].panes[1]).toEqual({ command: ["pi"], focus: true, split: "horizontal", percentage: 40 });

  add("feature/login");
  expect(f.tabs()).toHaveLength(1);
  expect(f.state().entries[0].phase).toBe("ready");
});

test("add starts from current HEAD or an explicit --branch", () => {
  const initial = f.git(["rev-parse", "main"]);
  f.git(["switch", "-c", "source"]);
  f.write(join(f.primary, "new.txt"), "source\n");
  f.git(["add", "."]);
  f.git(["commit", "-m", "Source"]);
  const current = f.git(["rev-parse", "HEAD"]);

  expect(f.git(["rev-parse", "HEAD"], add("from-current"))).toBe(current);
  expect(f.git(["rev-parse", "HEAD"], add("from-main", ["--branch", "main"]))).toBe(initial);
});

test("add uses an existing branch without resetting it", () => {
  f.git(["branch", "existing"]);
  add("existing");
  expect(f.wr(["add", "existing", "--branch", "main"]).code).toBe(1);

  f.git(["branch", "other"]);
  expect(f.wr(["add", "other", "--branch", "main"]).code).toBe(1);
});

test("add refuses unmanaged worktrees and path collisions", () => {
  f.git(["worktree", "add", "-b", "unmanaged", join(f.root, "unmanaged")]);
  expect(f.wr(["add", "unmanaged"]).err).toContain("unmanaged worktree");

  f.write(f.path("taken"), "do not overwrite");
  expect(f.wr(["add", "taken"]).err).toContain("already exists");
  expect(readFileSync(f.path("taken"), "utf8")).toBe("do not overwrite");
});

test("copy and symlink rules use the primary checkout, and arrays replace global defaults", () => {
  f.global({ files: { copy: ["nonexistent"], symlink: ["secret.txt"] }, panes: [{ command: ["sh"] }] });
  f.local({ files: { copy: [".env"] } });
  f.write(join(f.primary, ".env"), "primary\n");
  f.write(join(f.primary, "secret.txt"), "secret\n");
  f.git(["add", ".workrex.json"]);
  f.git(["commit", "-m", "Config"]);

  const first = add("first");
  expect(readFileSync(join(first, ".env"), "utf8")).toBe("primary\n");
  expect(readlinkSync(join(first, "secret.txt"))).toBe(join(f.primary, "secret.txt"));
  expect(f.tabs()[0].panes).toHaveLength(1);

  f.write(join(first, ".env"), "worktree\n");
  const second = f.wr(["add", "second"], first);
  expect(second.code).toBe(0);
  expect(readFileSync(join(f.path("second"), ".env"), "utf8")).toBe("primary\n");

  add("first");
  expect(readFileSync(join(first, ".env"), "utf8")).toBe("worktree\n");
});

test("file collisions preserve tracked content and the failed registration", () => {
  f.local({ files: { copy: ["tracked.txt"] } });
  expect(f.wr(["add", "collision"]).err).toContain("destination already exists");
  expect(readFileSync(join(f.path("collision"), "tracked.txt"), "utf8")).toBe("initial\n");
  expect(f.state().entries[0].phase).toBe("creating");

  expect(f.wr(["add", "collision"]).err).toContain("unfinished");
});

test("file rules refuse traversal, symlink escapes, overlap, and missing sources", () => {
  f.local({ files: { copy: ["../outside"] } });
  expect(f.wr(["add", "escape"]).err).toContain("Unsafe file rule");
  expect(existsSync(f.path("escape"))).toBe(false);

  f.write(join(f.root, "outside"), "private");
  symlinkSync(join(f.root, "outside"), join(f.primary, "link"));
  f.local({ files: { symlink: ["link"] } });
  expect(f.wr(["add", "escape"]).err).toContain("escapes primary");

  f.local({ files: { copy: ["tracked.txt"], symlink: ["tracked.txt"] } });
  expect(f.wr(["add", "escape"]).err).toContain("Overlapping");

  f.local({ files: { copy: ["missing"] } });
  expect(f.wr(["add", "escape"]).err).toContain("does not exist");
});

test("closed or timed-out tabs are recovered without duplicate worktrees or file copies", () => {
  add("reopen");
  const store = JSON.parse(readFileSync(f.env.WR_FAKE_STORE, "utf8"));
  store.tabs = [];
  writeFileSync(f.env.WR_FAKE_STORE, JSON.stringify(store));
  expect(f.wr(["ls"]).out).toContain("reopen\tclosed\tready");

  add("reopen");
  expect(f.tabs()).toHaveLength(1);

  const failure = f.wr(["add", "timeout"], f.primary, { WR_FAKE_FAIL: "open-after" });
  expect(failure.code).toBe(1);
  expect(f.state().entries.find((e: { branch: string }) => e.branch === "timeout").windowId).toBeNull();

  add("timeout");
  expect(f.tabs()).toHaveLength(2);
});

test.each(["select-after", "warn-selection"])("a tab selection failure is a friendly warning: %s", (failure) => {
  const result = f.wr(["add", "selection"], f.primary, { WR_FAKE_FAIL: failure });
  expect(result.code).toBe(0);
  expect(result.err).toBe(
    "The worktree tab is open, but automatic switching failed.\nTurn on Remote Control in Rex Settings under Rex Server.\n",
  );
  expect(result.out).toContain("selection\t");
  expect(f.state().entries[0].windowId).toBe(f.tabs()[0].window_id);

  const repeated = f.wr(["add", "selection"], f.primary, { WR_FAKE_FAIL: failure });
  expect(repeated.code).toBe(0);
  expect(repeated.err).toBe(result.err);
  expect(f.tabs()).toHaveLength(1);
});

test.each(["select-before", "select-missing"])("selection errors do not claim an unconfirmed tab is open: %s", (failure) => {
  const result = f.wr(["add", "unconfirmed"], f.primary, { WR_FAKE_FAIL: failure });

  expect(result.code).toBe(1);
  expect(result.err).not.toContain("The worktree tab is open");
  expect(f.state().entries[0].windowId).toBeNull();
});

test("ls is repository scoped and retains missing worktrees", () => {
  add("mine");
  const other = fixture();
  try {
    expect(other.wr(["ls"]).out).not.toContain("mine");
  } finally {
    other.dispose();
  }

  rmSync(f.path("mine"), { recursive: true });
  expect(f.wr(["ls"]).out).toContain("mine\topen\tmissing");
  expect(f.wr(["add", "mine"]).err).toContain("missing");
});

test("the executable works through an installation symlink", () => {
  const link = join(f.root, "wr");
  symlinkSync(executable, link);

  const result = f.command([link, "add", "installed"]);
  expect(result.err).toBe("");
  expect(result.code).toBe(0);
  expect(f.tabs()).toHaveLength(1);
});

test("failed worktree creation rolls back only a newly created unchanged branch", () => {
  const name = "é".repeat(48);
  expect(f.wr(["add", name, "--branch", "main"]).code).toBe(1);
  expect(f.command(["git", "show-ref", "--verify", `refs/heads/${name}`]).code).not.toBe(0);
  expect(f.state().entries).toEqual([]);

  f.git(["branch", name]);
  expect(f.wr(["add", name]).code).toBe(1);
  expect(f.git(["rev-parse", `refs/heads/${name}`])).toBe(f.git(["rev-parse", "main"]));
});

test("branch names and command flags cannot become shell arguments", () => {
  for (const name of ["-b", "HEAD", "../escape", "bad name"]) {
    expect(f.wr(["add", "--", name]).code).toBe(1);
  }

  add("semi;colon");
  expect(f.git(["branch", "--show-current"], f.path("semi;colon"))).toBe("semi;colon");

  expect(f.wr(["add"]).code).toBe(1);
  expect(f.wr(["add", "empty-source", "--branch", ""]).code).toBe(1);
  expect(f.wr(["ls", "--all"]).code).toBe(1);
});
