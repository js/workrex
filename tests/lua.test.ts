import { expect, test } from "bun:test";
import { resolve } from "node:path";

function open(existing: boolean, failSelection = false) {
  const result = Bun.spawnSync(["rex", "do", resolve(import.meta.dir, "lua-open.lua"), "--args", JSON.stringify({
    module: resolve(import.meta.dir, "../rex/wr.lua"), existing, fail_selection: failSelection,
  }), "--json"], { stdout: "pipe", stderr: "pipe" });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout.toString());
}

test.each([false, true])("wr_open selects the app tab, existing=%s", (existing) => {
  const result = open(existing);
  expect(result.selected).toEqual({ name: "session.select", args: { session_id: "session:test", window_id: "window:test" } });
  expect(result.opened).toBe(existing ? 0 : 1);
  expect(result.focused).toBe(existing ? "window:test" : "block:agent");
});

test("a rejected app selection preserves the tab ID and reports the failure", () => {
  const result = open(false, true);
  expect(result.result.window_id).toBe("window:test");
  expect(result.result.warning).toContain("Remote Control");
});
