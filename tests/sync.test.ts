import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { fixture } from "./helpers";

let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(() => { f.dispose(); });

function add(name: string, cwd = f.primary, args: string[] = []) {
  const result = f.wr(["add", name, ...args], cwd);
  expect(result.err).toBe("");
  expect(result.code).toBe(0);
  return f.path(name);
}

function sync(path: string, branch?: string) {
  const args = branch === undefined ? ["sync"] : ["sync", "--branch", branch];
  const result = f.wr(args, path, { REX_SESSION: "", WR_FAKE_FAIL: "open-before" });
  expect(result.err).toBe("");
  expect(result.code).toBe(0);
  return result;
}

function rewriteState(change: (state: any) => void) {
  const state = f.state();
  change(state);
  f.write(join(f.primary, ".git/workrex/state.json"), JSON.stringify(state));
}

test("sync overwrites copies, leaves identical links untouched, and does not need Rex", () => {
  f.local({ files: { copy: [".env"], symlink: ["secret.txt"] } });
  f.write(join(f.primary, ".env"), "original");
  f.write(join(f.primary, "secret.txt"), "shared");
  const path = add("child");
  const link = join(path, "secret.txt");
  const before = lstatSync(link);
  const tabs = readFileSync(f.env.WR_FAKE_STORE);
  const head = f.git(["rev-parse", "HEAD"], path);
  const state = f.state();
  f.write(join(f.primary, ".env"), "updated parent");
  f.write(join(path, ".env"), "overwrite me");

  expect(sync(path).out).toBe(`child\t${path}\tsynced\n`);
  sync(path);
  expect(readFileSync(join(path, ".env"), "utf8")).toBe("updated parent");
  expect(readFileSync(join(f.primary, ".env"), "utf8")).toBe("updated parent");
  expect(readlinkSync(link)).toBe(join(f.primary, "secret.txt"));
  expect(lstatSync(link).ino).toBe(before.ino);
  expect(lstatSync(link).mtimeMs).toBe(before.mtimeMs);
  expect(readFileSync(f.env.WR_FAKE_STORE)).toEqual(tabs);
  expect(f.git(["rev-parse", "HEAD"], path)).toBe(head);
  expect(f.state()).toEqual(state);
  expect(f.state().version).toBe(1);
});

test("add uses its parent but sync defaults to main, with primary project config", () => {
  f.global({ files: { copy: ["wrong.txt"], symlink: ["secret.txt"] } });
  f.local({ files: { copy: [".env"] } });
  f.write(join(f.primary, ".env"), "primary");
  f.write(join(f.primary, "secret.txt"), "shared");
  const parent = add("parent");
  f.write(join(parent, ".env"), "parent");
  f.write(join(parent, ".workrex.json"), "invalid and ignored");
  mkdirSync(join(parent, "subdir"));
  const child = add("child", join(parent, "subdir"));
  expect(readFileSync(join(child, ".env"), "utf8")).toBe("parent");
  expect(readlinkSync(join(child, "secret.txt"))).toBe(join(parent, "secret.txt"));
  expect(readFileSync(join(child, "secret.txt"), "utf8")).toBe("shared");

  f.git(["switch", "-c", "different-parent-branch"], parent);
  f.git(["switch", "-c", "different-child-branch"], child);
  f.write(join(parent, ".env"), "changed parent");
  f.local({ files: { copy: [".env"], symlink: [] } });
  mkdirSync(join(child, "subdir"));
  sync(join(child, "subdir"));
  expect(readFileSync(join(child, ".env"), "utf8")).toBe("primary");
  expect(f.state().entries[1].branch).toBe("child");
});

test("add --branch and sync --branch use the specified checkout without remembering it", () => {
  const parent = join(f.root, "external parent");
  f.git(["worktree", "add", "-b", "source", parent]);
  f.write(join(parent, ".env"), "source branch");
  f.write(join(parent, "secret.txt"), "source shared");
  f.write(join(f.primary, ".env"), "not this checkout");
  f.local({ files: { copy: [".env"], symlink: ["secret.txt"] } });
  const child = add("child", f.primary, ["--branch", "source"]);
  expect(readFileSync(join(child, ".env"), "utf8")).toBe("source branch");
  expect(readlinkSync(join(child, "secret.txt"))).toBe(join(parent, "secret.txt"));
  f.write(join(parent, ".env"), "new source");
  sync(child, "source");
  expect(readFileSync(join(child, ".env"), "utf8")).toBe("new source");
  sync(child);
  expect(readFileSync(join(child, ".env"), "utf8")).toBe("not this checkout");
});

test("add with no file rules permits an unchecked-out branch; sync requires a checkout", () => {
  f.git(["branch", "source"]);
  f.local({ files: { copy: [".env"] } });
  const failed = f.wr(["add", "blocked", "--branch", "source"]);
  expect(failed.code).toBe(1);
  expect(failed.err).toContain("Source branch source has no checkout");
  expect(existsSync(f.path("blocked"))).toBe(false);
  expect(f.command(["git", "show-ref", "--verify", "refs/heads/blocked"]).code).not.toBe(0);

  f.local({});
  const child = add("child", f.primary, ["--branch", "source"]);
  f.local({ files: { copy: [".env"] } });
  expect(f.wr(["sync", "--branch", "source"], child).err).toContain("has no checkout");
  const parent = join(f.root, "source checkout");
  f.git(["worktree", "add", parent, "source"]);
  f.write(join(parent, ".env"), "late source");
  sync(child, "source");
  expect(readFileSync(join(child, ".env"), "utf8")).toBe("late source");
});

test("sync applies newly configured rules and replaces entire directory copies", () => {
  const child = add("child");
  f.global({ files: { copy: ["ignored/data"], symlink: ["secret.txt"] } });
  f.write(join(f.primary, "ignored/data/new.txt"), "new");
  f.write(join(child, "ignored/data/stale.txt"), "remove on replacement");
  f.write(join(f.primary, "secret.txt"), "shared");
  sync(child);
  expect(readFileSync(join(child, "ignored/data/new.txt"), "utf8")).toBe("new");
  expect(existsSync(join(child, "ignored/data/stale.txt"))).toBe(false);
  expect(readlinkSync(join(child, "secret.txt"))).toBe(join(f.primary, "secret.txt"));
});

test("sync overwrites tracked copies without changing the index or HEAD", () => {
  const child = add("child");
  f.local({ files: { copy: ["tracked.txt"] } });
  f.write(join(f.primary, "tracked.txt"), "parent edit");
  f.write(join(child, "tracked.txt"), "local edit");
  f.git(["add", "tracked.txt"], child);
  const head = f.git(["rev-parse", "HEAD"], child);
  sync(child);
  expect(readFileSync(join(child, "tracked.txt"), "utf8")).toBe("parent edit");
  expect(f.git(["show", ":tracked.txt"], child)).toBe("local edit");
  expect(f.git(["rev-parse", "HEAD"], child)).toBe(head);
});

test("sync skips missing sources without removing existing targets", () => {
  const child = add("child");
  f.local({ files: { copy: [".env", "missing/sub/file"], symlink: ["secret.txt"] } });
  f.write(join(child, ".env"), "keep copy");
  symlinkSync(join(f.primary, "secret.txt"), join(child, "secret.txt"));
  sync(child);
  expect(readFileSync(join(child, ".env"), "utf8")).toBe("keep copy");
  expect(readlinkSync(join(child, "secret.txt"))).toBe(join(f.primary, "secret.txt"));
  expect(existsSync(join(child, "missing"))).toBe(false);
});

test("sync accepts relative symlinks to the same parent path without replacing them", () => {
  const child = add("child");
  f.local({ files: { symlink: ["secret.txt"] } });
  f.write(join(f.primary, "secret.txt"), "shared");
  const target = relative(child, join(f.primary, "secret.txt"));
  symlinkSync(target, join(child, "secret.txt"));
  sync(child);
  expect(readlinkSync(join(child, "secret.txt"))).toBe(target);
});

function failedSync(path: string, ...errors: string[]) {
  const result = f.wr(["sync"], path);
  expect(result.code).toBe(1);
  expect(result.out).not.toContain("synced");
  for (const error of errors) expect(result.err).toContain(error);
  return result;
}

test.each(["wrong-link", "dangling-link", "file", "directory"])("sync reports a conflicting symlink target and still applies the other rules: %s", (kind) => {
  const child = add("child");
  f.local({ files: { copy: [".env"], symlink: ["secret.txt", "other.txt"] } });
  f.write(join(f.primary, ".env"), "new");
  f.write(join(f.primary, "secret.txt"), "shared");
  f.write(join(f.primary, "other.txt"), "other");
  f.write(join(child, ".env"), "overwritten");
  const target = join(child, "secret.txt");
  const wrong = join(f.root, "wrong");
  if (kind === "file") f.write(target, "conflict");
  else if (kind === "directory") f.write(join(target, "keep.txt"), "keep");
  else {
    if (kind === "wrong-link") f.write(wrong, "do not modify");
    symlinkSync(wrong, target);
  }
  const result = failedSync(child, "symlink secret.txt", "Conflicting symlink destination", "1 file rule failed");
  expect(result.err.match(/Conflicting symlink destination/g)).toHaveLength(1);
  expect(readFileSync(join(child, ".env"), "utf8")).toBe("new");
  expect(readlinkSync(join(child, "other.txt"))).toBe(join(f.primary, "other.txt"));
  if (kind === "file") expect(readFileSync(target, "utf8")).toBe("conflict");
  else if (kind === "directory") expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("keep");
  else {
    expect(readlinkSync(target)).toBe(wrong);
    if (kind === "wrong-link") expect(readFileSync(wrong, "utf8")).toBe("do not modify");
  }
});

test("sync reports every failed rule in one run, applies later rules, and succeeds on retry", () => {
  const child = add("child");
  f.local({
    files: {
      copy: ["blocked", "bad-source", "first.txt", "second.txt"],
      symlink: ["node_modules", "dep.txt", "last.txt"],
    },
  });
  f.write(join(f.primary, "blocked/file"), "new");
  f.write(join(child, "blocked/.git"), "protected");
  f.write(join(f.primary, "bad-source/file"), "x");
  symlinkSync(join(f.primary, "tracked.txt"), join(f.primary, "bad-source/link"));
  f.write(join(f.primary, "first.txt"), "first");
  f.write(join(f.primary, "second.txt"), "second");
  f.write(join(child, "first.txt"), "overwrite me");
  f.write(join(f.primary, "node_modules/pkg/index.js"), "shared");
  f.write(join(child, "node_modules/local/index.js"), "local install");
  f.write(join(f.primary, "dep.txt"), "dep");
  f.write(join(f.primary, "last.txt"), "last");

  failedSync(child, "copy blocked", "Cannot overwrite Git metadata", "copy bad-source", "contains a symlink",
    "symlink node_modules", "Conflicting symlink destination", "3 file rules failed");
  expect(readFileSync(join(child, "blocked/.git"), "utf8")).toBe("protected");
  expect(existsSync(join(child, "blocked/file"))).toBe(false);
  expect(existsSync(join(child, "bad-source"))).toBe(false);
  expect(readFileSync(join(child, "first.txt"), "utf8")).toBe("first");
  expect(readFileSync(join(child, "second.txt"), "utf8")).toBe("second");
  expect(lstatSync(join(child, "node_modules")).isDirectory()).toBe(true);
  expect(readFileSync(join(child, "node_modules/local/index.js"), "utf8")).toBe("local install");
  expect(readlinkSync(join(child, "dep.txt"))).toBe(join(f.primary, "dep.txt"));
  expect(readlinkSync(join(child, "last.txt"))).toBe(join(f.primary, "last.txt"));

  rmSync(join(child, "blocked"), { recursive: true });
  rmSync(join(child, "node_modules"), { recursive: true });
  rmSync(join(f.primary, "bad-source"), { recursive: true });
  const result = sync(child);
  expect(result.out).toBe(`child\t${child}\tsynced\n`);
  expect(readFileSync(join(child, "blocked/file"), "utf8")).toBe("new");
  expect(readlinkSync(join(child, "node_modules"))).toBe(join(f.primary, "node_modules"));
});

test.skipIf(process.getuid?.() === 0)("sync reports a copy that cannot be installed and continues", () => {
  const child = add("child");
  f.local({ files: { copy: ["denied/.env", "next.txt"], symlink: ["link.txt"] } });
  f.write(join(f.primary, "denied/.env"), "new");
  f.write(join(f.primary, "next.txt"), "next");
  f.write(join(f.primary, "link.txt"), "shared");
  f.write(join(child, "denied/.env"), "old");
  chmodSync(join(child, "denied"), 0o555);
  try {
    failedSync(child, "copy denied/.env", "1 file rule failed");
    expect(readFileSync(join(child, "denied/.env"), "utf8")).toBe("old");
    expect(readdirSync(join(child, "denied"))).toEqual([".env"]);
    expect(readFileSync(join(child, "next.txt"), "utf8")).toBe("next");
    expect(readlinkSync(join(child, "link.txt"))).toBe(join(f.primary, "link.txt"));
  } finally {
    chmodSync(join(child, "denied"), 0o755);
  }
  expect(sync(child).out).toBe(`child\t${child}\tsynced\n`);
  expect(readFileSync(join(child, "denied/.env"), "utf8")).toBe("new");
});

test.skipIf(process.getuid?.() === 0)("sync continues when copy and symlink sources cannot be inspected", () => {
  const child = add("child");
  f.local({ files: { copy: ["denied/copy", "next.txt"], symlink: ["denied/link", "last.txt"] } });
  f.write(join(f.primary, "denied/copy"), "copy source");
  f.write(join(f.primary, "denied/link"), "link source");
  f.write(join(f.primary, "next.txt"), "next");
  f.write(join(f.primary, "last.txt"), "last");
  f.write(join(child, "denied/copy"), "keep copy");
  f.write(join(child, "denied/link"), "keep link target");
  chmodSync(join(f.primary, "denied"), 0o000);
  try {
    failedSync(child, "copy denied/copy", "symlink denied/link", "2 file rules failed");
    expect(readFileSync(join(child, "denied/copy"), "utf8")).toBe("keep copy");
    expect(readFileSync(join(child, "denied/link"), "utf8")).toBe("keep link target");
    expect(readFileSync(join(child, "next.txt"), "utf8")).toBe("next");
    expect(readlinkSync(join(child, "last.txt"))).toBe(join(f.primary, "last.txt"));
  } finally {
    chmodSync(join(f.primary, "denied"), 0o755);
  }
});

test("sync still stops before installing anything for invalid configuration or overlapping rules", () => {
  const child = add("child");
  f.write(join(f.primary, "ok.txt"), "new");
  f.write(join(f.primary, "ignored/file"), "source");
  f.write(join(child, "ok.txt"), "unchanged");
  for (const [files, message] of [
    [{ copy: ["ok.txt", "../outside"] }, "Unsafe file rule"],
    [{ copy: ["ok.txt", "ignored", "ignored/file"] }, "Overlapping file rules"],
    [{ copy: ["ok.txt"], symlink: "ok.txt" }, "files.symlink must be an array"],
  ] as const) {
    f.local({ files });
    const result = f.wr(["sync"], child);
    expect(result.code).toBe(1);
    expect(result.err).toContain(message);
    expect(result.err).not.toContain("file rule failed");
    expect(readFileSync(join(child, "ok.txt"), "utf8")).toBe("unchanged");
  }
});

test.each(["symlink", "dangling", "hardlink", "nested-symlink"])("copy replacement never writes through destination links: %s", (kind) => {
  const child = add("child");
  f.local({ files: { copy: ["ignored/target"] } });
  const outside = join(f.root, "outside");
  const target = join(child, "ignored/target");
  mkdirSync(join(child, "ignored"));
  if (kind !== "dangling") f.write(outside, "untouched");
  if (kind === "nested-symlink") {
    f.write(join(f.primary, "ignored/target/file"), "new");
    mkdirSync(target);
    symlinkSync(outside, join(target, "file"));
  } else {
    f.write(join(f.primary, "ignored/target"), "new");
    if (kind === "hardlink") linkSync(outside, target);
    else symlinkSync(outside, target);
  }
  sync(child);
  expect(readFileSync(kind === "nested-symlink" ? join(target, "file") : target, "utf8")).toBe("new");
  if (kind === "dangling") expect(existsSync(outside)).toBe(false);
  else expect(readFileSync(outside, "utf8")).toBe("untouched");
});

test("sync refuses symlinked destination ancestors and embedded Git metadata", () => {
  const child = add("child");
  const outside = join(f.root, "outside");
  f.write(join(outside, "file"), "untouched");
  f.local({ files: { copy: ["ignored/file"] } });
  f.write(join(f.primary, "ignored/file"), "new");
  symlinkSync(outside, join(child, "ignored"));
  expect(failedSync(child, "copy ignored/file").err).toContain("not a real directory");
  expect(readFileSync(join(outside, "file"), "utf8")).toBe("untouched");

  rmSync(join(child, "ignored"));
  f.write(join(child, "ignored/.git"), "protected");
  f.local({ files: { copy: ["ignored"] } });
  failedSync(child, "Cannot overwrite Git metadata");
  expect(readFileSync(join(child, "ignored/.git"), "utf8")).toBe("protected");
});

test("sync rejects source escapes, traversal, overlaps, and source links back into the destination", () => {
  const child = add("child");
  f.write(join(f.root, "outside"), "untouched");
  f.local({ files: { symlink: ["secret.txt"] } });
  symlinkSync(join(f.root, "outside"), join(f.primary, "secret.txt"));
  expect(f.wr(["sync"], child).err).toContain("escapes source");
  rmSync(join(f.primary, "secret.txt"));
  f.write(join(child, "secret.txt"), "do not create a loop");
  symlinkSync(join(child, "secret.txt"), join(f.primary, "secret.txt"));
  expect(f.wr(["sync"], child).code).toBe(1);
  expect(readFileSync(join(child, "secret.txt"), "utf8")).toBe("do not create a loop");

  f.local({ files: { copy: ["../outside"] } });
  expect(f.wr(["sync"], child).err).toContain("Unsafe file rule");
  f.write(join(f.primary, "ignored/file"), "source");
  f.local({ files: { copy: ["ignored", "ignored/file"] } });
  expect(f.wr(["sync"], child).err).toContain("Overlapping file rules");
});

test("sync finds main outside primary and follows its current checkout location", () => {
  f.git(["switch", "-c", "primary-feature"]);
  const main = join(f.root, "main checkout");
  f.git(["worktree", "add", main, "main"]);
  const child = add("child");
  f.local({ main_branch: "primary-feature", files: { copy: [".env"] } });
  f.write(join(f.primary, ".env"), "not main");
  f.write(join(main, ".env"), "main source");
  sync(child);
  expect(readFileSync(join(child, ".env"), "utf8")).toBe("main source");
  const moved = join(f.root, "moved main");
  f.git(["worktree", "move", main, moved]);
  f.write(join(moved, ".env"), "moved source");
  sync(child);
  expect(readFileSync(join(child, ".env"), "utf8")).toBe("moved source");
});

test("sync refuses missing branches/checkouts, ambiguous sources, and itself", () => {
  const child = add("child");
  f.local({ files: { copy: [".env"] } });
  f.write(join(child, ".env"), "keep");
  expect(f.wr(["sync", "--branch", "unknown"], child).err).toContain("does not exist locally");
  expect(f.wr(["sync", "--branch", "child"], child).err).toContain("from itself");
  f.git(["switch", "-c", "other"]);
  expect(f.wr(["sync"], child).err).toContain("Source branch main has no checkout");
  const source = join(f.root, "main");
  f.git(["worktree", "add", source, "main"]);
  rmSync(source, { recursive: true });
  expect(f.wr(["sync"], child).err).toContain("Source checkout is missing");
  f.git(["worktree", "prune"]);
  f.git(["branch", "-m", "main", "renamed-main"]);
  expect(f.wr(["sync"], child).err).toContain("Source branch does not exist locally: main");
  const duplicate = join(f.root, "duplicate");
  f.git(["worktree", "add", "--force", duplicate, "other"]);
  expect(f.wr(["sync", "--branch", "other"], child).err).toContain("multiple checkouts");
  expect(readFileSync(join(child, ".env"), "utf8")).toBe("keep");
});

test("sync --branch reports links to another source and still updates other rules", () => {
  const child = add("child");
  const source = add("source");
  f.local({ files: { copy: [".env"], symlink: ["secret.txt"] } });
  for (const path of [f.primary, source]) {
    f.write(join(path, ".env"), path);
    f.write(join(path, "secret.txt"), "shared");
  }
  sync(child);
  const result = f.wr(["sync", "--branch", "source"], child);
  expect(result.code).toBe(1);
  expect(result.out).not.toContain("synced");
  expect(result.err).toContain("Conflicting symlink destination");
  expect(readFileSync(join(child, ".env"), "utf8")).toBe(source);
  expect(readlinkSync(join(child, "secret.txt"))).toBe(join(f.primary, "secret.txt"));
});

test("unrelated missing worktrees do not block file setup or sync", () => {
  const missing = join(f.root, "missing");
  f.git(["worktree", "add", "-b", "missing", missing]);
  expect(f.wr(["open", "missing"]).code).toBe(0);
  rmSync(missing, { recursive: true });
  symlinkSync(join(f.root, "absent"), missing);
  f.local({ files: { copy: [".env"] } });
  f.write(join(f.primary, ".env"), "source");
  const child = add("child");
  sync(child);
  expect(readFileSync(join(child, ".env"), "utf8")).toBe("source");
});

function external(name: string, extra: string[] = ["-b", name]) {
  const path = join(f.root, name);
  f.git(["worktree", "add", ...extra, path]);
  return path;
}

const state = () => join(f.primary, ".git/workrex/state.json");

test("sync works in an unregistered linked worktree without Rex or state", () => {
  f.local({ files: { copy: [".env"], symlink: ["secret.txt"] } });
  f.write(join(f.primary, ".env"), "from main");
  f.write(join(f.primary, "secret.txt"), "shared");
  const path = external("external");
  f.write(join(path, ".env"), "overwrite me");
  const tabs = existsSync(f.env.WR_FAKE_STORE);

  expect(sync(path).out).toBe(`external\t${path}\tsynced\n`);
  expect(readFileSync(join(path, ".env"), "utf8")).toBe("from main");
  expect(readlinkSync(join(path, "secret.txt"))).toBe(join(f.primary, "secret.txt"));
  expect(existsSync(state())).toBe(false);
  expect(existsSync(f.env.WR_FAKE_STORE)).toBe(tabs);

  const sub = join(path, "nested");
  mkdirSync(sub);
  f.write(join(f.primary, ".env"), "again");
  expect(sync(sub).out).toBe(`external\t${path}\tsynced\n`);
  expect(readFileSync(join(path, ".env"), "utf8")).toBe("again");
});

test("sync --branch and detached HEAD work in an unregistered linked worktree", () => {
  const source = external("source");
  const detached = external("detached", ["--detach"]);
  f.local({ files: { copy: [".env"] } });
  f.write(join(f.primary, ".env"), "main");
  f.write(join(source, ".env"), "source");
  expect(sync(detached, "source").out).toBe(`(detached)\t${detached}\tsynced\n`);
  expect(readFileSync(join(detached, ".env"), "utf8")).toBe("source");
  expect(existsSync(state())).toBe(false);
});

test("sync in a registered external worktree keeps its registration and tab state", () => {
  f.local({ files: { copy: [".env"] } });
  f.write(join(f.primary, ".env"), "from main");
  const path = external("external");
  expect(f.wr(["open", "external"]).code).toBe(0);
  const registered = f.state();
  const tabs = readFileSync(f.env.WR_FAKE_STORE);

  expect(sync(path).out).toBe(`external\t${path}\tsynced\n`);
  expect(readFileSync(join(path, ".env"), "utf8")).toBe("from main");
  expect(f.state()).toEqual(registered);
  expect(f.state().entries[0].phase).toBe("external");
  expect(readFileSync(f.env.WR_FAKE_STORE)).toEqual(tabs);
});

test("sync refuses primary, locked, unfinished, and stale-identity worktrees without changing copies", () => {
  f.local({ files: { copy: [".env"] } });
  f.write(join(f.primary, ".env"), "main");
  expect(f.wr(["sync"]).err).toContain("protected or locked");
  expect(f.wr(["sync"], f.root).err).toContain("not a git repository");

  const path = external("external");
  f.write(join(path, ".env"), "keep");
  const refused = (message: string) => {
    expect(f.wr(["sync"], path).err).toContain(message);
    expect(readFileSync(join(path, ".env"), "utf8")).toBe("keep");
  };
  f.git(["worktree", "lock", path]);
  refused("protected or locked");
  f.git(["worktree", "unlock", path]);
  expect(f.wr(["open", "external"]).code).toBe(0);
  f.git(["worktree", "lock", path]);
  refused("protected or locked");
  f.git(["worktree", "unlock", path]);

  for (const phase of ["creating", "removing"]) {
    rewriteState((state) => { state.entries[0].phase = phase; });
    refused(`unfinished ${phase}`);
  }
  rewriteState((state) => { state.entries[0].phase = "external"; state.entries[0].gitDir = join(f.root, "elsewhere"); });
  refused("ownership changed");
  rewriteState((state) => { state.entries[0].gitDir = f.git(["rev-parse", "--absolute-git-dir"], path); });
  expect(f.wr(["sync", "--branch", "external"], path).err).toContain("from itself");
  expect(readFileSync(join(path, ".env"), "utf8")).toBe("keep");
});

test("sync checks unfinished registrations through path aliases", () => {
  const child = add("child");
  const alias = join(f.root, "alias");
  symlinkSync(child, alias);
  f.local({ files: { copy: [".env"] } });
  f.write(join(f.primary, ".env"), "source");
  f.write(join(child, ".env"), "keep");
  for (const phase of ["creating", "removing"]) {
    rewriteState((state) => { state.entries[0].path = alias; state.entries[0].phase = phase; });
    expect(f.wr(["sync"], child).err).toContain(`unfinished ${phase}`);
    expect(readFileSync(join(child, ".env"), "utf8")).toBe("keep");
  }
});

test("sync supports old registrations and refuses unfinished managed worktrees", () => {
  const child = add("child");
  expect(f.state().version).toBe(1);
  expect(f.state().entries[0]).not.toHaveProperty("parent");
  f.local({ files: { copy: [".env"] } });
  f.write(join(f.primary, ".env"), "works without parent metadata");
  sync(child);
  expect(readFileSync(join(child, ".env"), "utf8")).toBe("works without parent metadata");
  for (const phase of ["creating", "removing"]) {
    rewriteState((state) => { state.entries[0].phase = phase; });
    expect(f.wr(["sync"], child).err).toContain(`unfinished ${phase}`);
  }
});

test("sync rejects extra arguments and honors repository and worktree locks", () => {
  for (const args of [["sync", "child"], ["sync", "--force"], ["sync", "--branch"], ["sync", "--branch", "main", "extra"]]) {
    expect(f.wr(args, f.root).err).toBe("wr: Usage: wr sync [--branch <source>]\n");
  }
  const child = add("child");
  mkdirSync(join(f.primary, ".git/workrex/lock"));
  expect(f.wr(["sync"], child).err).toContain("Another wr mutation");
  rmSync(join(f.primary, ".git/workrex/lock"), { recursive: true });
  f.git(["worktree", "lock", child]);
  expect(f.wr(["sync"], child).err).toContain("locked worktree");
});
