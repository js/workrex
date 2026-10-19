import { resolve } from "node:path";
import { object, text, type Layout } from "./config";
import type { Entry } from "./repo";

const luaScript = process.env.WR_LUA ? resolve(process.env.WR_LUA) : null;

function call(action: string, args: Record<string, unknown>): Record<string, unknown> {
  const command = luaScript ? [luaScript, "--action", action] : [action];
  const result = Bun.spawnSync(["rex", "--timeout", "30s", "do", ...command, "--args", JSON.stringify(args), "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    const message = result.stderr.toString().trim() || "action failed";
    throw new Error(`Rex: ${message}`);
  }

  return object(JSON.parse(result.stdout.toString()), `Rex ${action} response`);
}

function target(entry: Entry) {
  return { session_id: entry.sessionId, window_id: entry.windowId ?? undefined };
}

export function inspectTab(entry: Entry): { windowId: string | null; sessionExists: boolean; ownTab: boolean } {
  const result = call("wr_status", { ...target(entry), caller_block: process.env.REX_BLOCK || undefined });
  if (typeof result.session_exists !== "boolean" || typeof result.own_tab !== "boolean") {
    throw new Error("Invalid Rex tab status");
  }

  return {
    windowId: result.window_id === false ? null : text(result.window_id, "window_id"),
    sessionExists: result.session_exists,
    ownTab: result.own_tab,
  };
}

function warnSelection(message: string) {
  console.error("The worktree tab is open, but automatic switching failed.");
  console.error(
    message.includes("Rex.app is not accepting actions") && message.includes("Remote Control")
      ? "Turn on Remote Control in Rex Settings under Rex Server."
      : message,
  );
}

export function openTab(entry: Entry, panes: Layout, label: string): string {
  try {
    const result = call("wr_open", {
      ...target(entry), label, cwd: entry.path,
      panes: panes.map(({ command, focus, split }) => ({
        command, focus, parent: split && split.from + 1, split: split?.direction, percentage: split?.percentage,
      })),
    });
    const windowId = text(result.window_id, "window_id");
    if (result.warning) {
      warnSelection(text(result.warning, "warning"));
    }
    return windowId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message}\nRex did not confirm the tab. If it created a new tab, close that tab manually before retrying wr add.`,
    );
  }
}

export function closeTab(entry: Entry) {
  const result = call("wr_close", target(entry));
  if (result.closed !== true) {
    throw new Error("Rex did not confirm tab closure");
  }
}
