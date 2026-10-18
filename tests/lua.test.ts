import { expect, test } from "bun:test";
import { resolve } from "node:path";

function open(existing: boolean, failSelection = false, command?: string[]) {
  const args = { module: resolve(import.meta.dir, "../rex/wr.lua"), existing, fail_selection: failSelection, command };
  const result = Bun.spawnSync(
    ["rex", "do", resolve(import.meta.dir, "lua-open.lua"), "--args", JSON.stringify(args), "--json"],
    { stdout: "pipe", stderr: "pipe" },
  );

  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout.toString());
}

test.each([false, true])("wr_open selects the app tab, existing=%s", (existing) => {
  const result = open(existing);

  expect(result.selected).toEqual({ name: "session.select", args: { session_id: "session:test", window_id: "window:test" } });
  expect(result.opened).toBe(existing ? 0 : 1);
  expect(result.focused).toBe(existing ? "window:test" : "block:agent");
  if (existing) {
    expect(result.layout).toBeUndefined();
  } else {
    expect(result.layout.split.before.block.options).toEqual({ cwd: "/test", initial_input: "'nvim' '.'\r" });
    expect(result.layout.split.after.block.options).toEqual({ cwd: "/test", initial_input: "'pi'\r" });
  }
});

test.each(["sh", "bash", "zsh", "fish"].filter((shell) => Bun.which(shell)))("pane arguments stay literal in %s", (shell) => {
  const executable = Bun.which(shell)!;
  const args = ["two words", "single'quote", 'double"quote', "back\\\\slash", "trailing\\", "$HOME", "$(printf injected)",
    "`printf injected`", "(printf injected)", "semi; printf injected", "*.txt", "!history", "line\nbreak", "æøå"];
  const command = [process.execPath, "-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--", ...args];
  const options = open(false, false, command).layout.block.options;
  expect(options.command).toBeUndefined();
  expect(options.initial_input.endsWith("\r")).toBe(true);

  const flags = shell === "fish" ? ["--no-config"] : shell === "zsh" ? ["-f"] : [];
  const result = Bun.spawnSync([executable, ...flags, "-c", options.initial_input.slice(0, -1)], { stdout: "pipe", stderr: "pipe" });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual(args);
});

test("a rejected app selection preserves the tab ID and reports the failure", () => {
  const result = open(false, true);

  expect(result.result.window_id).toBe("window:test");
  expect(result.result.warning).toContain("Remote Control");
});
