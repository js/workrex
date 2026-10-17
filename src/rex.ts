import { resolve } from "node:path";
import { object, text, type Pane } from "./config";
import type { Entry } from "./repo";

function call(action: string, args: Record<string, unknown>): Record<string, unknown> {
  const command = process.env.WR_LUA ? [resolve(process.env.WR_LUA), "--action", action] : [action];
  const result = Bun.spawnSync(["rex", "--timeout", "30s", "do", ...command, "--args", JSON.stringify(args), "--json"], { stdout: "pipe", stderr: "pipe" });
  if (result.error) throw result.error;
  if (result.exitCode !== 0) throw new Error(`Rex: ${result.stderr.toString().trim() || "action failed"}`);
  return object(JSON.parse(result.stdout.toString()), `Rex ${action} response`);
}

function target(entry: Entry) {
  return { session_id: entry.sessionId, window_id: entry.windowId ?? undefined, label: entry.label };
}

export function inspectTab(entry: Entry): { windowId: string | null; sessionExists: boolean; ownTab: boolean } {
  const result = call("wr_status", { ...target(entry), caller_block: process.env.REX_BLOCK || undefined });
  if (typeof result.session_exists !== "boolean" || typeof result.own_tab !== "boolean") throw new Error("Invalid Rex tab status");
  return { windowId: result.window_id === false ? null : text(result.window_id, "window_id"), sessionExists: result.session_exists, ownTab: result.own_tab };
}

export function openTab(entry: Entry, panes: Pane[]): string {
  const result = call("wr_open", { ...target(entry), cwd: entry.path, panes });
  if (result.warning) console.error(`wr: tab opened, but focus failed: ${result.warning}`);
  return text(result.window_id, "window_id");
}

export function closeTab(entry: Entry) {
  const result = call("wr_close", target(entry));
  if (result.closed !== true) throw new Error("Rex did not confirm tab closure");
}
