import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./helpers";

let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(() => { f.dispose(); });

const modes = [
  { command: "ls", verbose: false },
  { command: "ls", verbose: true },
  { command: "list", verbose: false },
  { command: "list", verbose: true },
];

test.each(modes)("$command aligns columns (verbose=$verbose)", ({ command, verbose }) => {
  for (const name of ["rex-inversion", "swift", "gone"]) {
    expect(f.wr(["add", name]).code).toBe(0);
  }
  f.git(["switch", "-c", "new/topic"], f.path("swift"));
  const external = join(f.root, "external worktree");
  f.git(["worktree", "add", "-b", "修正", external]);
  expect(f.wr(["open", "修正"]).code).toBe(0);

  const store = JSON.parse(readFileSync(f.env.WR_FAKE_STORE, "utf8"));
  store.tabs = store.tabs.filter((tab: { cwd: string }) => tab.cwd !== f.path("swift"));
  writeFileSync(f.env.WR_FAKE_STORE, JSON.stringify(store));
  rmSync(f.path("gone"), { recursive: true });

  const stateBefore = f.state();
  const result = f.wr([command, ...(verbose ? ["--verbose"] : [])]);
  const expected = verbose ? [
    "WORKTREE       BRANCH         TAB     STATE     PATH",
    `rex-inversion  rex-inversion  open    ready     ${f.path("rex-inversion")}`,
    `swift          new/topic      closed  ready     ${f.path("swift")}`,
    `gone           gone           open    missing   ${f.path("gone")}`,
    `修正           修正           open    external  ${external}`,
  ] : [
    "WORKTREE       BRANCH         TAB     STATE",
    "rex-inversion  rex-inversion  open    ready",
    "swift          new/topic      closed  ready",
    "gone           gone           open    missing",
    "修正           修正           open    external",
  ];
  expect(result).toEqual({ code: 0, err: "", out: expected.join("\n") + "\n" });
  expect(f.state()).toEqual(stateBefore);
});

test.each(modes)("$command prints headers for an empty registry (verbose=$verbose)", ({ command, verbose }) => {
  expect(f.wr([command, ...(verbose ? ["--verbose"] : [])])).toEqual({
    code: 0,
    err: "",
    out: verbose ? "WORKTREE  BRANCH  TAB  STATE  PATH\n" : "WORKTREE  BRANCH  TAB  STATE\n",
  });
});

test("ls distinguishes detached HEADs from unavailable branch information", () => {
  for (const name of ["topic", "gone"]) {
    expect(f.wr(["add", name]).code).toBe(0);
  }
  f.git(["switch", "--detach", "HEAD"], f.path("topic"));
  rmSync(f.path("gone"), { recursive: true });
  f.git(["worktree", "prune"]);

  const stateBefore = f.state();
  expect(f.wr(["ls"])).toEqual({
    code: 0,
    err: "",
    out: [
      "WORKTREE  BRANCH      TAB   STATE",
      "topic     (detached)  open  ready",
      "gone      -           open  missing",
    ].join("\n") + "\n",
  });
  expect(f.state()).toEqual(stateBefore);
});

test.each(["ls", "list"])("%s rejects unknown options and positional arguments", (command) => {
  for (const args of [["--unknown"], ["extra"], ["--verbose", "extra"], ["--verbose=false"], ["--compact"]]) {
    expect(f.wr([command, ...args], f.root)).toEqual({
      code: 1,
      out: "",
      err: "wr: Usage: wr ls [--verbose]\n",
    });
  }
});
