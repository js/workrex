import { expect, test } from "bun:test";
import { resolve } from "node:path";

type Options = {
  failSelection?: boolean;
  missingSession?: boolean;
  command?: string | string[];
  windows?: { window_id: string; label: string }[];
  panes?: Record<string, unknown>[];
  blockIds?: string[];
};

function run(existing: boolean, options: Options = {}) {
  const args = { module: resolve(import.meta.dir, "../rex/wr.lua"), existing, fail_selection: options.failSelection, missing_session: options.missingSession,
    command: options.command, windows: options.windows, panes: options.panes, block_ids: options.blockIds };
  const result = Bun.spawnSync(
    ["rex", "do", resolve(import.meta.dir, "lua-open.lua"), "--args", JSON.stringify(args), "--json"],
    { stdout: "pipe", stderr: "pipe" },
  );

  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout.toString());
}

function open(existing: boolean, options: Options = {}) {
  const result = run(existing, options);
  expect(result.error).toBeUndefined();
  return result;
}

const blockIds = ["block:1", "block:2", "block:3"];
const editor = { command: ["nvim", "."] };
const agent = { command: ["pi"], parent: 1, split: "horizontal", percentage: 60, focus: true };
const bff = { command: ["bun", "run", "start:bff"], parent: 2, split: "vertical", percentage: 28 };
const leaf = (input: string) => ({ block: { flavor: "com.superlogical.terminal.shell", options: { cwd: "/test", initial_input: input } } });

test.each([false, true])("wr_open selects the app tab, existing=%s", (existing) => {
  const result = open(existing);

  expect(result.selected).toEqual({ name: "session.select", args: { session_id: "session:test", window_id: "window:test" } });
  expect(result.opened).toBe(existing ? 0 : 1);
  expect(result.focused).toBe(existing ? "window:test" : "block:agent");
  if (existing) {
    expect(result.layout).toBeUndefined();
  } else {
    expect(result.label).toBe("workrex/test");
    expect(result.layout.split.before.block.options).toEqual({ cwd: "/test", initial_input: "'nvim' '.'\r" });
    expect(result.layout.split.after.block.options).toEqual({ cwd: "/test", initial_input: "'pi'\r" });
    expect(result.layout.split.direction).toBe("horizontal");
    expect(result.layout.split.ratio).toBeCloseTo(0.6);
  }
});

test.each([false, true])("wr_open reports a missing session before attachment, existing=%s", (existing) => {
  const result = run(existing, { missingSession: true });
  expect(result.error).toBe("Rex session no longer exists. Run add from a live Rex session.");
  expect(result.opened).toBe(0);
  expect(result.selected).toBeUndefined();
});

test("a pane can split an earlier split pane, nesting the layout", () => {
  const result = open(false, { panes: [editor, agent, bff], blockIds });
  const { split } = result.layout;
  expect(split.direction).toBe("horizontal");
  expect(split.ratio).toBeCloseTo(0.4);
  expect(split.before).toEqual(leaf("'nvim' '.'\r"));
  expect(split.after.split.direction).toBe("vertical");
  expect(split.after.split.ratio).toBeCloseTo(0.72);
  expect(split.after.split.before).toEqual(leaf("'pi'\r"));
  expect(split.after.split.after).toEqual(leaf("'bun' 'run' 'start:bff'\r"));
  expect(result.focused).toBe("block:2");
});

test("splitting one pane twice nests the earlier split and focuses by depth-first position", () => {
  const result = open(false, { panes: [editor, agent, { ...bff, parent: 1 }], blockIds });
  const { split } = result.layout;
  expect(split.direction).toBe("horizontal");
  expect(split.ratio).toBeCloseTo(0.4);
  expect(split.before.split.direction).toBe("vertical");
  expect(split.before.split.ratio).toBeCloseTo(0.72);
  expect(split.before.split.before).toEqual(leaf("'nvim' '.'\r"));
  expect(split.before.split.after).toEqual(leaf("'bun' 'run' 'start:bff'\r"));
  expect(split.after).toEqual(leaf("'pi'\r"));
  expect(result.focused).toBe("block:3");
});

test("both columns can contain stacked panes, with focus on the last configured pane", () => {
  const result = open(false, {
    panes: [editor, { ...agent, focus: false }, bff,
      { command: ["tail", "-f", "app.log"], parent: 1, split: "vertical", percentage: 50, focus: true }],
    blockIds: [...blockIds, "block:4"],
  });
  const { split } = result.layout;
  expect(split.direction).toBe("horizontal");
  expect(split.ratio).toBeCloseTo(0.4);
  expect(split.before.split.direction).toBe("vertical");
  expect(split.before.split.ratio).toBeCloseTo(0.5);
  expect(split.before.split.before).toEqual(leaf("'nvim' '.'\r"));
  expect(split.before.split.after).toEqual(leaf("'tail' '-f' 'app.log'\r"));
  expect(split.after.split.direction).toBe("vertical");
  expect(split.after.split.ratio).toBeCloseTo(0.72);
  expect(split.after.split.before).toEqual(leaf("'pi'\r"));
  expect(split.after.split.after).toEqual(leaf("'bun' 'run' 'start:bff'\r"));
  expect(result.focused).toBe("block:2");
});

test("without a focused pane, the first pane gets focus", () => {
  const result = open(false, { panes: [editor, { ...agent, focus: false }, { ...bff, parent: 1 }], blockIds });
  expect(result.layout.split.before.split.before).toEqual(leaf("'nvim' '.'\r"));
  expect(result.focused).toBe("block:1");
});

test.each([
  ["no panes", [], "Expected at least one pane"],
  ["an empty command string", [{ command: "" }], "Pane command"],
  ["a command string containing NUL", [{ command: "pi\0" }], "Pane command"],
  ["a numeric command", [{ command: 42 }], "Pane command"],
  ["parent 0", [editor, { ...agent, parent: 0 }], "Invalid split parent"],
  ["parent equal to its own position", [editor, { ...agent, parent: 2 }], "Invalid split parent"],
  ["a later parent", [editor, { ...agent, parent: 3 }, bff], "Invalid split parent"],
  ["a fractional parent", [editor, { ...agent, parent: 1.5 }], "Invalid split parent"],
  ["a string parent", [editor, { ...agent, parent: "1" }], "Invalid split parent"],
  ["a bad split", [editor, { ...agent, split: "diagonal" }], "Invalid split direction"],
  ["a missing split", [editor, { ...agent, split: undefined }], "Invalid split direction"],
  ["percentage 0", [editor, { ...agent, percentage: 0 }], "Invalid split percentage"],
  ["percentage 100", [editor, { ...agent, percentage: 100 }], "Invalid split percentage"],
  ["a string percentage", [editor, { ...agent, percentage: "40" }], "Invalid split percentage"],
  ["a fractional percentage", [editor, { ...agent, percentage: 40.5 }], "Invalid split percentage"],
  ["two focused panes", [{ ...editor, focus: true }, agent], "Only one pane can have focus"],
])("wr_open rejects %s without opening a tab", (_, panes, error) => {
  const result = run(false, { panes });
  expect(result.error).toStartWith(error);
  expect(result.opened).toBe(0);
});

test.each([false, true])("same-title tabs are not adopted when the saved ID is absent or stale: %s", (existing) => {
  const result = open(existing, { windows: [{ window_id: "window:unrelated", label: "workrex/test" }] });
  expect(result.opened).toBe(1);
});

test("a saved window ID finds a renamed tab even when another tab has its old title", () => {
  const result = open(true, { windows: [
    { window_id: "window:unrelated", label: "workrex/test" },
    { window_id: "window:test", label: "My custom title" },
  ] });
  expect(result.opened).toBe(0);
  expect(result.focused).toBe("window:test");
});

test.each(["sh", "bash", "zsh", "fish"].filter((shell) => Bun.which(shell)))("pane arguments stay literal in %s", (shell) => {
  const executable = Bun.which(shell)!;
  const args = ["two words", "single'quote", 'double"quote', "back\\\\slash", "trailing\\", "$HOME", "$(printf injected)",
    "`printf injected`", "(printf injected)", "semi; printf injected", "*.txt", "!history", "line\nbreak", "æøå"];
  const command = [process.execPath, "-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--", ...args];
  const options = open(false, { command }).layout.block.options;
  expect(options.command).toBeUndefined();
  expect(options.initial_input.endsWith("\r")).toBe(true);

  const flags = shell === "fish" ? ["--no-config"] : shell === "zsh" ? ["-f"] : [];
  const result = Bun.spawnSync([executable, ...flags, "-c", options.initial_input.slice(0, -1)], { stdout: "pipe", stderr: "pipe" });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual(args);
});

test.each(["sh", "bash", "zsh", "fish"].filter((shell) => Bun.which(shell)))("string commands use shell syntax in %s", (shell) => {
  const command = 'printf "%s\\n" "$WR_STRING_VALUE" && printf done';
  const options = open(false, { command }).layout.block.options;
  expect(options.initial_input).toBe(command + "\r");
  const flags = shell === "fish" ? ["--no-config"] : shell === "zsh" ? ["-f"] : [];
  const result = Bun.spawnSync([Bun.which(shell)!, ...flags, "-c", options.initial_input.slice(0, -1)], {
    env: { ...process.env, WR_STRING_VALUE: "two words" }, stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  expect(result.stdout.toString()).toBe("two words\ndone");
});

test("a rejected app selection preserves the tab ID and reports the failure", () => {
  const result = open(false, { failSelection: true });

  expect(result.result.window_id).toBe("window:test");
  expect(result.result.warning).toContain("Remote Control");
});
