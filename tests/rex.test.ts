import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { fixture } from "./helpers";

const real = test.skipIf(process.env.WR_REAL_REX !== "1");

real("real Rex opens the configured split, reuses it, and recreates a closed tab", () => {
  const f = fixture();
  const env = { ...f.env, PATH: process.env.PATH, WR_LUA: resolve(import.meta.dir, "../rex/wr.lua") };
  function rex(args: string[]) {
    const result = Bun.spawnSync(["rex", ...args], { env, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode) throw new Error(result.stderr.toString());
    return result.stdout.toString();
  }
  const session = JSON.parse(rex(["new", "wr-test-layout", "-c", f.root, "--json"])).session_id;
  const overrides = { PATH: process.env.PATH!, WR_LUA: env.WR_LUA, REX_SESSION: session, REX_BLOCK: "" };
  try {
    f.local({ panes: [
      { command: ["sh", "-c", "printf 'wr-editor\\n'; exec sh"] },
      { command: ["sh", "-c", "printf 'wr-agent\\n'; exec sh"], split: "horizontal", percentage: 40, focus: true },
    ] });
    const added = f.wr(["add", "layout"], f.primary, overrides);
    expect(added.err).toBe("");
    expect(added.code).toBe(0);
    const entry = f.state().entries[0];
    const view = JSON.parse(rex(["session", "inspect", session, "--json"]));
    const tab = view.windows.find((w) => w.window_id === entry.windowId);
    expect(view.active_window_id).toBe(entry.windowId);
    const layout = tab.layers[0].layout;
    expect(layout.split.direction).toBe("horizontal");
    expect(layout.split.ratio).toBeCloseTo(0.6);
    expect(tab.focused_block_id).toBe(layout.split.after.block_id);
    expect(f.wr(["add", "layout"], f.primary, overrides).code).toBe(0);
    expect(JSON.parse(rex(["session", "inspect", session, "--json"])).windows).toHaveLength(2);
    console.log(JSON.stringify({ window: entry.windowId, split: layout.split.direction, ratio: layout.split.ratio, focused: tab.focused_block_id }));
    rex(["window", "close", "-s", session, entry.windowId]);
    expect(f.wr(["ls"], f.primary, overrides).out).toContain("layout\tclosed");
    expect(f.wr(["add", "layout"], f.primary, overrides).code).toBe(0);
    expect(f.state().entries[0].windowId).not.toBe(entry.windowId);
  } finally {
    rex(["kill", session]);
    f.dispose();
  }
}, 30_000);
