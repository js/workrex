import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { executable, fixture } from "./helpers";

const real = test.skipIf(process.env.WR_REAL_REX !== "1");

async function waitUntil(check: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for Rex terminal state");
    }
    await Bun.sleep(50);
  }
}

real("real Rex opens the configured split, reuses it, and recreates a closed tab", async () => {
  const f = fixture();
  const env = { ...f.env, PATH: process.env.PATH, WR_LUA: resolve(import.meta.dir, "../rex/wr.lua") };
  function rex(args: string[]) {
    const result = Bun.spawnSync(["rex", ...args], { env, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode) {
      throw new Error(result.stderr.toString());
    }
    return result.stdout.toString();
  }

  const session = JSON.parse(rex(["new", "wr-test-layout", "-c", f.root, "--json"])).session_id;
  const overrides = { PATH: process.env.PATH!, WR_LUA: env.WR_LUA, REX_SESSION: session, REX_BLOCK: "" };
  try {
    f.local({ panes: [
      { command: ["sh", "-c", "printf 'wr-editor\\n'"] },
      { command: ["sh", "-c", "printf 'wr-agent\\n'"], split: "horizontal", percentage: 40, focus: true },
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
        if (screen.includes(marker)) {
          break;
        }
        await Bun.sleep(50);
      }
      expect(screen).toContain(marker);
    }

    expect(f.wr(["add", "layout"], f.primary, overrides).code).toBe(0);
    expect(JSON.parse(rex(["session", "inspect", session, "--json"])).windows).toHaveLength(2);
    console.log(JSON.stringify({
      window: entry.windowId,
      split: layout.split.direction,
      ratio: layout.split.ratio,
      focused: tab.focused_block_id,
    }));

    rex(["window", "close", "-s", session, entry.windowId]);
    expect(f.wr(["ls"], f.primary, overrides).out).toContain("layout\tclosed");
    expect(f.wr(["add", "layout"], f.primary, overrides).code).toBe(0);
    expect(f.state().entries[0].windowId).not.toBe(entry.windowId);
  } finally {
    rex(["kill", session]);
    f.dispose();
  }
}, 30_000);

real("pane shells remain usable after a successful exit, failure, or Ctrl-C", async () => {
  const f = fixture();
  const env = { ...f.env, PATH: process.env.PATH, WR_LUA: resolve(import.meta.dir, "../rex/wr.lua") };
  function rex(args: string[]) {
    const result = Bun.spawnSync(["rex", ...args], { env, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode) {
      throw new Error(result.stderr.toString());
    }
    return result.stdout.toString();
  }

  const session = JSON.parse(rex(["new", "wr-test-shells", "-c", f.root, "--json"])).session_id;
  const overrides = { PATH: process.env.PATH!, WR_LUA: env.WR_LUA, REX_SESSION: session, REX_BLOCK: "" };
  try {
    for (const mode of ["success", "failure", "interrupt"]) {
      const action = mode === "interrupt" ? "exec sleep 60" : `exit ${mode === "success" ? 0 : 7}`;
      f.local({ panes: [{ command: ["sh", "-c", `printf started > .wr-command-started; ${action}`] }] });
      const added = f.wr(["add", mode], f.primary, overrides);
      expect(added.err).toBe("");
      expect(added.code).toBe(0);

      const entry = f.state().entries.find((e: { branch: string }) => e.branch === mode);
      const view = JSON.parse(rex(["session", "inspect", session, "--json"]));
      const tab = view.windows.find((w: { window_id: string }) => w.window_id === entry.windowId);
      const block = tab.layers[0].blocks[0].block_id;
      const process = () => JSON.parse(rex(["block", "call", "-s", session, "-b", block, "process"]));
      await waitUntil(() => existsSync(join(entry.path, ".wr-command-started")));
      const terminalPid = process().child.pid;

      if (mode === "interrupt") {
        await waitUntil(() => process().foreground?.name === "sleep");
        const commandPid = process().foreground.pid;
        rex(["send-key", "-s", session, "-b", block, "ctrl+c"]);
        await waitUntil(() => {
          const foreground = process().foreground;
          return !!foreground && foreground.pid !== commandPid;
        });
      }
      expect(process().last_exit).toBeNull();

      rex(["send", "-s", session, "-b", block, "pwd > .wr-shell-cwd"]);
      rex(["send-key", "-s", session, "-b", block, "enter"]);
      const output = join(entry.path, ".wr-shell-cwd");
      await waitUntil(() => existsSync(output) && readFileSync(output, "utf8").trim() === entry.path);
      expect(process().child.pid).toBe(terminalPid);
      expect(f.wr(["add", mode], f.primary, overrides).code).toBe(0);
      expect(f.state().entries.find((e: { branch: string }) => e.branch === mode).windowId).toBe(entry.windowId);
    }
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
    if (result.exitCode) {
      throw new Error(result.stderr.toString());
    }
    return result.stdout.toString();
  }

  const session = JSON.parse(rex(["new", `wr-test-self-${action}`, "-c", f.root, "--json"])).session_id;
  const overrides = { PATH: process.env.PATH!, WR_LUA: env.WR_LUA, REX_SESSION: session, REX_BLOCK: "" };
  try {
    const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;
    const command = [
      "env",
      `WR_LUA=${env.WR_LUA}`,
      `XDG_CONFIG_HOME=${f.xdg}`,
      `PATH=${process.env.PATH}`,
      "GIT_CONFIG_GLOBAL=/dev/null",
      "GIT_AUTHOR_NAME=Test",
      "GIT_AUTHOR_EMAIL=test@example.invalid",
      "GIT_COMMITTER_NAME=Test",
      "GIT_COMMITTER_EMAIL=test@example.invalid",
      executable,
      action,
      "self",
    ].map(quote).join(" ");
    const trigger = join(f.root, "start");
    const runner = join(f.root, "run.sh");
    f.write(runner, `while [ ! -f ${quote(trigger)} ]; do sleep 0.05; done\n${command}\n`);
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
    while (Date.now() < deadline && f.state().entries.length) {
      await Bun.sleep(50);
    }
    if (f.state().entries.length) {
      const log = join(f.primary, ".git/workrex/cleanup.log");
      console.error(existsSync(log) ? readFileSync(log, "utf8") : rex(["capture", "-s", session, "-b", block, "--trim"]));
    }

    expect(f.state().entries).toEqual([]);
    expect(existsSync(entry.path)).toBe(false);
    expect(JSON.parse(rex(["session", "inspect", session, "--json"])).windows).toHaveLength(1);
    expect(existsSync(join(f.primary, ".git/workrex/lock"))).toBe(false);
    if (action === "merge") {
      expect(readFileSync(join(f.primary, "feature.txt"), "utf8")).toBe("merged from its own tab\n");
    }
    console.log(`Verified ${action} from owned tab ${entry.windowId}; Git, tab, registration, and lock removed.`);
  } finally {
    rex(["kill", session]);
    f.dispose();
  }
}, 30_000);
