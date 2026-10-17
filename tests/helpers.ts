import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const executable = resolve(import.meta.dir, "../wr");

export function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wr test ")));
  const primary = join(root, "project space");
  const xdg = join(root, "config");
  const bin = join(root, "bin");
  mkdirSync(primary);
  mkdirSync(bin);
  symlinkSync(resolve(import.meta.dir, "fake-rex"), join(bin, "rex"));
  const env = { ...process.env, WR_LUA: "", PATH: `${bin}:${process.env.PATH}`, XDG_CONFIG_HOME: xdg, WR_FAKE_STORE: join(root, "rex.json"), REX_SESSION: "session:test", REX_BLOCK: "block:parent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
  function command(argv: string[], cwd = primary, overrides: Record<string, string> = {}) {
    const result = Bun.spawnSync(argv, { cwd, env: { ...env, ...overrides }, stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
  }
  function git(args: string[], cwd = primary) {
    const result = command(["git", ...args], cwd);
    if (result.code) throw new Error(result.err);
    return result.out.trim();
  }
  function write(path: string, contents: string) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  git(["init", "-b", "main"]);
  write(join(primary, "tracked.txt"), "initial\n");
  write(join(primary, ".gitignore"), ".env\nsecret.txt\nignored/\n");
  git(["add", "."]);
  git(["commit", "-m", "Initial"]);
  return {
    root, primary, xdg, env, command, git, write,
    wr: (args: string[], cwd = primary, overrides: Record<string, string> = {}) => command([executable, ...args], cwd, overrides),
    path: (branch: string) => join(root, "project space__worktrees", encodeURIComponent(branch)),
    local: (data: unknown) => write(join(primary, ".workrex.json"), JSON.stringify(data)),
    global: (data: unknown) => write(join(xdg, "workrex/config.json"), JSON.stringify(data)),
    state: () => JSON.parse(readFileSync(join(primary, ".git/workrex/state.json"), "utf8")),
    tabs: () => JSON.parse(readFileSync(env.WR_FAKE_STORE, "utf8")).tabs,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}
