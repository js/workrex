import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { executable, fixture } from "./helpers";

const real = test.skipIf(process.env.WR_REAL_REX !== "1");

real("real Rex opens the configured split, reuses it, and recreates a closed tab", async () => {
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
    const tab = view.windows.find((w: { window_id: string }) => w.window_id === entry.windowId);
    expect(view.active_window_id).toBe(entry.windowId);
    const layout = tab.layers[0].layout;
    expect(layout.split.direction).toBe("horizontal");
    expect(layout.split.ratio).toBeCloseTo(0.6);
    expect(tab.focused_block_id).toBe(layout.split.after.block_id);
    for (const [block, marker] of [[layout.split.before.block_id, "wr-editor"], [layout.split.after.block_id, "wr-agent"]]) {
      const deadline = Date.now() + 3_000;
      let screen = "";
      while (Date.now() < deadline) {
        screen = rex(["capture", "-s", session, "-b", block, "--trim"]);
        if (screen.includes(marker)) break;
        await Bun.sleep(50);
      }
      expect(screen).toContain(marker);
    }
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

real.each(["merge", "rm"])("real Rex can %s from the tab being removed", async (action) => {
  const f = fixture();
  const env = { ...f.env, PATH: process.env.PATH, WR_LUA: resolve(import.meta.dir, "../rex/wr.lua") };
  function rex(args: string[]) {
    const result = Bun.spawnSync(["rex", ...args], { env, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode) throw new Error(result.stderr.toString());
    return result.stdout.toString();
  }
  const session = JSON.parse(rex(["new", `wr-test-self-${action}`, "-c", f.root, "--json"])).session_id;
  const overrides = { PATH: process.env.PATH!, WR_LUA: env.WR_LUA, REX_SESSION: session, REX_BLOCK: "" };
  try {
    const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;
    const command = ["env", `WR_LUA=${env.WR_LUA}`, `XDG_CONFIG_HOME=${f.xdg}`, `PATH=${process.env.PATH}`, "GIT_CONFIG_GLOBAL=/dev/null", "GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=test@example.invalid", "GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=test@example.invalid", executable, action, "self"].map(quote).join(" ");
    const trigger = join(f.root, "start");
    const runner = join(f.root, "run.sh");
    f.write(runner, `while [ ! -f ${quote(trigger)} ]; do sleep 0.05; done\n${command}\nexec sh\n`);
    f.local({ panes: [{ command: ["sh", runner] }] });
    f.git(["add", ".workrex.json"]);
    f.git(["commit", "-m", "Layout"]);
    expect(f.wr(["add", "self"], f.primary, overrides).code).toBe(0);
    const entry = f.state().entries[0];
    if (action === "merge") {
      f.write(join(entry.path, "feature.txt"), "merged from its own tab\n");
      f.git(["add", "feature.txt"], entry.path);
      f.git(["commit", "-m", "Feature"], entry.path);
    }
    const view = JSON.parse(rex(["session", "inspect", session, "--json"]));
    const tab = view.windows.find((w: { window_id: string }) => w.window_id === entry.windowId);
    const block = tab.layers[0].blocks[0].block_id;
    f.write(trigger, "start\n");
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && f.state().entries.length) await Bun.sleep(50);
    if (f.state().entries.length) {
      const log = join(f.primary, ".git/workrex/cleanup.log");
      console.error(existsSync(log) ? readFileSync(log, "utf8") : rex(["capture", "-s", session, "-b", block, "--trim"]));
    }
    expect(f.state().entries).toEqual([]);
    expect(existsSync(entry.path)).toBe(false);
    expect(JSON.parse(rex(["session", "inspect", session, "--json"])).windows).toHaveLength(1);
    expect(existsSync(join(f.primary, ".git/workrex/lock"))).toBe(false);
    if (action === "merge") expect(readFileSync(join(f.primary, "feature.txt"), "utf8")).toBe("merged from its own tab\n");
    console.log(`Verified ${action} from owned tab ${entry.windowId}; Git, tab, registration, and lock removed.`);
  } finally {
    rex(["kill", session]);
    f.dispose();
  }
}, 30_000);
