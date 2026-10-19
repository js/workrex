import { existsSync, lstatSync, readFileSync, realpathSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

export function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw new Error(`${label} must be a nonempty string`);
  }
  return value;
}

function keys(value: Record<string, unknown>, allowed: string[], label: string) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`Unknown ${label} setting: ${key}`);
    }
  }
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value.map((item) => text(item, label));
}

type Direction = "horizontal" | "vertical";
export type Split = { from: number; direction: Direction; percentage: number };
export type RootPane = { command: string | string[]; focus: boolean; split?: never };
export type SplitPane = { command: string | string[]; focus: boolean; split: Split };
export type Layout = [RootPane, ...SplitPane[]];
export type Config = { panes: Layout; files: { copy: string[]; symlink: string[] }; main_branch?: string };

function readConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    return {};
  }
  return object(JSON.parse(readFileSync(path, "utf8")), path);
}

export function config(primary: string): Config {
  const defaults: Record<string, unknown> = {
    panes: [{ command: ["nvim", "."] }, { command: ["pi"], split: "horizontal", percentage: 40, focus: true }],
    files: { copy: [], symlink: [] },
  };
  const global = readConfig(join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "workrex/config.json"));
  const local = readConfig(join(primary, ".workrex.json"));
  for (const layer of [global, local]) {
    keys(layer, ["panes", "files", "main_branch"], "configuration");
  }

  const merged = { ...defaults, ...global, ...local };
  const files = { copy: [], symlink: [], ...object(global.files ?? {}, "files"), ...object(local.files ?? {}, "files") };
  keys(files, ["copy", "symlink"], "files");

  return {
    panes: parsePanes(merged.panes),
    files: { copy: strings(files.copy, "files.copy"), symlink: strings(files.symlink, "files.symlink") },
    main_branch: merged.main_branch === undefined ? undefined : text(merged.main_branch, "main_branch"),
  };
}

function parsePanes(value: unknown): Layout {
  if (!Array.isArray(value) || !value.length) {
    throw new Error("panes must be a nonempty array");
  }
  const ids = new Map<string, number>();
  const panes = value.map((item, index): SplitPane => {
    const pane = object(item, "pane");
    keys(pane, ["id", "command", "focus", "split_from", "split", "percentage"], "pane");

    const command = typeof pane.command === "string" ? text(pane.command, "pane.command") : strings(pane.command, "pane.command");
    if (!command.length) {
      throw new Error("pane.command must not be empty");
    }
    if (pane.focus !== undefined && typeof pane.focus !== "boolean") {
      throw new Error("pane.focus must be boolean");
    }
    if (index === 0 && (pane.split_from !== undefined || pane.split !== undefined || pane.percentage !== undefined)) {
      throw new Error("The first pane cannot specify split_from, split, or percentage");
    }

    const from = pane.split_from === undefined ? index - 1 : ids.get(text(pane.split_from, "pane.split_from"));
    if (from === undefined) {
      throw new Error(`pane.split_from must name the id of an earlier pane: ${pane.split_from}`);
    }
    const direction = pane.split ?? "horizontal";
    if (direction !== "horizontal" && direction !== "vertical") {
      throw new Error("pane.split must be horizontal or vertical");
    }
    const percentage = pane.percentage ?? 40;
    if (typeof percentage !== "number" || !Number.isInteger(percentage) || percentage < 1 || percentage > 99) {
      throw new Error("pane.percentage must be an integer from 1 to 99");
    }

    if (pane.id !== undefined) {
      const id = text(pane.id, "pane.id");
      if (ids.has(id)) {
        throw new Error(`Duplicate pane id: ${id}`);
      }
      ids.set(id, index);
    }
    return { command, focus: pane.focus === true, split: { from, direction, percentage } };
  });
  if (panes.filter((pane) => pane.focus).length > 1) {
    throw new Error("Only one pane can have focus");
  }

  const [{ command, focus }, ...rest] = panes;
  return [{ command, focus }, ...rest];
}

export function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export type FileRule = { kind: "copy" | "symlink"; path: string };

export function fileRules(primary: string, cfg: Config): FileRule[] {
  const rules: FileRule[] = [
    ...cfg.files.copy.map((path): FileRule => ({ kind: "copy", path })),
    ...cfg.files.symlink.map((path): FileRule => ({ kind: "symlink", path })),
  ].filter((rule) => {
    const parts = rule.path.split("/");
    if (isAbsolute(rule.path) || parts.some((p) => !p || p === "." || p === ".." || p === ".git")) {
      throw new Error(`Unsafe file rule: ${rule.path}`);
    }

    const source = join(primary, rule.path);
    if (!present(source)) {
      return false;
    }
    if (!inside(primary, realpathSync(source))) {
      throw new Error(`File-rule source escapes primary checkout: ${source}`);
    }
    if (rule.kind === "copy") {
      checkCopy(source);
    }
    return true;
  });

  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      if (inside(rules[i].path, rules[j].path) || inside(rules[j].path, rules[i].path)) {
        throw new Error(`Overlapping file rules: ${rules[i].path}, ${rules[j].path}`);
      }
    }
  }

  return rules;
}

function checkCopy(path: string) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new Error(`Copy source contains a symlink; use files.symlink instead: ${path}`);
  }

  if (stat.isDirectory()) {
    for (const child of readdirSync(path)) {
      if (child === ".git") {
        throw new Error(`Cannot copy Git metadata: ${path}`);
      }
      checkCopy(join(path, child));
    }
  } else if (!stat.isFile()) {
    throw new Error(`Copy source is not a regular file: ${path}`);
  }
}
