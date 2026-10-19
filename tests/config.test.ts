import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { config } from "../src/config";

let root: string;
const xdg = process.env.XDG_CONFIG_HOME;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "wr config ")));
  process.env.XDG_CONFIG_HOME = join(root, "config");
});
afterEach(() => {
  process.env.XDG_CONFIG_HOME = xdg;
  rmSync(root, { recursive: true, force: true });
});

function panes(value: unknown) {
  writeFileSync(join(root, ".workrex.json"), JSON.stringify({ panes: value }));
  return config(root).panes;
}

const editor = { id: "editor", command: ["nvim", "."] };
const agent = { id: "agent", command: ["pi"], split_from: "editor", split: "horizontal", percentage: 60, focus: true };
const bff = { command: ["bun", "run", "start:bff"], split_from: "agent", split: "vertical", percentage: 28 };

test("the default layout is nvim with pi split to its right and focused", () => {
  expect(config(root).panes).toEqual([
    { command: ["nvim", "."], focus: false },
    { command: ["pi"], focus: true, split: { from: 0, direction: "horizontal", percentage: 40 } },
  ]);
});

test("split_from names an earlier pane by id", () => {
  expect(panes([editor, agent, bff])).toEqual([
    { command: ["nvim", "."], focus: false },
    { command: ["pi"], focus: true, split: { from: 0, direction: "horizontal", percentage: 60 } },
    { command: ["bun", "run", "start:bff"], focus: false, split: { from: 1, direction: "vertical", percentage: 28 } },
  ]);
});

test("commands accept shell strings and literal argument arrays in the same layout", () => {
  const shell = 'printf "%s\\n" "$HOME" && pwd';
  const commands = [shell, ["nvim", "notes with spaces.md"], "bun run start:bff"];
  expect(panes(commands.map((command) => ({ command }))).map((pane) => pane.command)).toEqual(commands);
});

test("panes without split_from split the previous pane horizontally at 40 percent", () => {
  expect(panes([{ command: ["a"] }, { command: ["b"] }, { command: ["c"] }])).toEqual([
    { command: ["a"], focus: false },
    { command: ["b"], focus: false, split: { from: 0, direction: "horizontal", percentage: 40 } },
    { command: ["c"], focus: false, split: { from: 1, direction: "horizontal", percentage: 40 } },
  ]);
});

test("one pane can be split more than once", () => {
  expect(panes([editor, agent, { ...bff, split_from: "editor" }]).map((pane) => pane.split?.from)).toEqual([undefined, 0, 0]);
});

test("the example config nests a third pane under the focused agent", () => {
  writeFileSync(join(root, ".workrex.jsonc"), readFileSync(join(import.meta.dir, "../examples/config.jsonc")));
  expect(config(root).panes.map((pane) => [pane.split?.from, pane.focus])).toEqual([[undefined, false], [0, true], [1, false]]);
});

test.each([
  ["global", "jsonc"], ["project", "jsonc"], ["global", "json"], ["project", "json"],
])("%s .%s config accepts comments and trailing commas without altering strings", (scope, extension) => {
  const path = scope === "global" ? join(root, `config/workrex/config.${extension}`) : join(root, `.workrex.${extension}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, String.raw`// A comment before the object.
  {
    /* Comments can span
       multiple lines. */
    "panes": [
      { "command": ["printf", "https://example.test/a//b", "/* literal */", "C:\\files",], },
    ],
    "files": { "copy": [".env",], }, // Keep the trailing commas.
  } // A comment after the object.
  `);
  expect(config(root)).toMatchObject({
    panes: [{ command: ["printf", "https://example.test/a//b", "/* literal */", "C:\\files"], focus: false }],
    files: { copy: [".env"], symlink: [] },
  });
});

test.each(["global", "project"])("%s JSONC takes precedence over JSON without merging the two", (scope) => {
  const base = scope === "global" ? join(root, "config/workrex/config") : join(root, ".workrex");
  mkdirSync(dirname(base), { recursive: true });
  writeFileSync(base + ".json", JSON.stringify({ panes: [{ command: "legacy" }], files: { copy: ["old.env"] } }));
  writeFileSync(base + ".jsonc", '{ /* preferred */ "panes": [{ "command": "preferred" }], }');
  expect(config(root)).toMatchObject({ panes: [{ command: "preferred" }], files: { copy: [], symlink: [] } });

  writeFileSync(base + ".jsonc", '{ /* invalid */ "panes": }');
  expect(() => config(root)).toThrow(SyntaxError);
});

test.each(["jsonc", "json"])("commented project .%s config still overrides and inherits global JSONC settings", (extension) => {
  mkdirSync(join(root, "config/workrex"), { recursive: true });
  writeFileSync(join(root, "config/workrex/config.jsonc"), `{
    // Shared settings.
    "panes": [{ "command": "pi" }],
    "files": { "copy": [".env"], "symlink": ["node_modules"] },
    "main_branch": "main",
  }`);
  writeFileSync(join(root, `.workrex.${extension}`), `{
    /* Keep the global panes and copy rules. */
    "files": { "symlink": [], },
    "main_branch": "develop",
  }`);
  expect(config(root)).toEqual({
    panes: [{ command: "pi", focus: false }],
    files: { copy: [".env"], symlink: [] },
    main_branch: "develop",
  });
});

test.each([
  ["a missing value", '{ "panes": /* missing */ }'],
  ["an unterminated object", '{ "panes": [] // missing closing brace'],
  ["unquoted keys", '{ panes: [] }'],
])("JSONC rejects %s", (_, contents) => {
  writeFileSync(join(root, ".workrex.jsonc"), contents);
  expect(() => config(root)).toThrow(SyntaxError);
});

test("comments do not bypass config validation", () => {
  writeFileSync(join(root, ".workrex.jsonc"), '{ /* unsupported */ "hooks": [] }');
  expect(() => config(root)).toThrow("Unknown configuration setting: hooks");
});

test.each([
  ["an empty list", [], /panes/],
  ["a non-array", { editor }, /panes/],
  ["an unknown key", [{ ...editor, size: 3 }], /Unknown pane setting: size/],
  ["an empty command", [{ command: [] }], /pane.command/],
  ["an empty command string", [{ command: "" }], /pane.command/],
  ["a command string containing NUL", [{ command: "pi\u0000" }], /pane.command/],
  ["a numeric command", [{ command: 42 }], /pane.command/],
  ["a null command", [{ command: null }], /pane.command/],
  ["an object command", [{ command: { shell: "pi" } }], /pane.command/],
  ["an empty command argument", [{ command: ["pi", ""] }], /pane.command/],
  ["a non-string command argument", [{ command: ["pi", 42] }], /pane.command/],
  ["a duplicate id", [editor, { ...agent, id: "editor" }], /Duplicate pane id/],
  ["an empty id", [{ ...editor, id: "" }], /pane.id/],
  ["an id containing NUL", [{ ...editor, id: "edi\0tor" }], /pane.id/],
  ["a numeric id", [{ ...editor, id: 1 }], /pane.id/],
  ["an unknown split_from", [editor, { ...agent, split_from: "missing" }], /split_from/],
  ["a split_from naming itself", [editor, { ...agent, split_from: "agent" }], /split_from/],
  ["a split_from naming a later pane", [editor, { ...agent, split_from: "bff" }, { ...bff, id: "bff" }], /split_from/],
  ["a non-string split_from", [editor, { ...agent, split_from: 0 }], /split_from/],
  ["split_from on the first pane", [{ ...editor, split_from: "editor" }], /first pane/],
  ["split on the first pane", [{ ...editor, split: "vertical" }], /first pane/],
  ["percentage on the first pane", [{ ...editor, percentage: 40 }], /first pane/],
  ["a diagonal split", [editor, { ...agent, split: "diagonal" }], /pane.split/],
  ["percentage 0", [editor, { ...agent, percentage: 0 }], /pane.percentage/],
  ["percentage 100", [editor, { ...agent, percentage: 100 }], /pane.percentage/],
  ["percentage 40.5", [editor, { ...agent, percentage: 40.5 }], /pane.percentage/],
  ["a string percentage", [editor, { ...agent, percentage: "40" }], /pane.percentage/],
  ["a string focus", [{ ...editor, focus: "true" }], /pane.focus/],
  ["two focused panes", [{ ...editor, focus: true }, agent], /Only one pane can have focus/],
])("panes rejects %s", (_, value, error) => {
  expect(() => panes(value)).toThrow(error);
});
