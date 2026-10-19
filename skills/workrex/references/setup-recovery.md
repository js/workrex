# Workrex setup and recovery

## Installation and Rex integration

Workrex requires Bun, Git, and Rex. Use `command -v` to identify missing dependencies. Resolve an installed `wr` symlink to find its checkout and current README. If no checkout is available, ask for its location or the intended installation source rather than guessing a remote.

To expose a known Workrex checkout on PATH, create `~/.local/bin` if needed and link its `wr` executable there. Inspect an existing `~/.local/bin/wr` before replacing it; preserve unrelated installations. Use an absolute source path and ensure `~/.local/bin` is on PATH.

The Workrex checkout contains `rex/wr.lua`. Rex must load it to register the `wr_*` actions:

1. Run `rex config check` and read the config file reported on its `path:` line. Rex uses `REX_CONFIG` when set, otherwise `$XDG_CONFIG_HOME/rex/init.lua` or `~/.config/rex/init.lua`.
2. Preserve existing Lua configuration and `package.path` setup. Add the Workrex module directory after that setup, substituting the actual absolute checkout path:

   ```lua
   package.path = "/absolute/path/to/workrex/rex/?.lua;" .. package.path
   require("wr")
   ```

3. Inspect any legacy `~/.config/rex/wr.lua` symlink. Remove it only after confirming it is the obsolete Workrex link; preserve regular files or unrelated modules. A stale copy can shadow the intended module.
4. Run `rex config check`, then reload with `rex config reload` only if validation succeeds. Verify `wr --help`. JSON Workrex changes alone do not need this reload.

For a temporary, command-scoped module test without changing Rex config:

```sh
WR_LUA="/absolute/path/to/workrex/rex/wr.lua" wr add experiment
```

This **creates a real worktree and tab**; use it only when requested, not as a read-only installation check. If automatic tab switching fails but creation succeeds, ask the user to enable Remote Control under Rex Server in Rex Settings. Reinstalling or recreating the worktree will not fix that permission.

## Interrupted operations

Start with `wr ls`, `git worktree list --porcelain`, and the affected worktree's Git status. If Rex is unreachable, inspect Git and the registry read-only; do not infer that the tab disappeared.

| Symptom | Next step |
| --- | --- |
| Rebase conflict during merge | Keep the worktree/tab. Resolve and stage in that worktree, then `git rebase --continue`, or abort with `git rebase --abort`. Retry `wr merge <name>` with the same intended target after the Git operation finishes. |
| Tab opening failed or timed out | Inspect the recorded Rex session before retrying. A tab may exist without a saved window ID; identify it carefully, close only that orphan tab with permission, then retry `wr add <name>`. Titles are not recovery identities. |
| Entry is `creating` after failed file setup | Inspect existing files and the error. With explicit authorization to abandon that worktree, use `wr rm <name> --force`, then fix config and recreate. Repeating `add` will not finish file setup. |
| Entry is `removing` after Git cleanup | Retry `wr rm <name>` to finish tab/registry cleanup. It resumes removal; force is not needed merely to close the tab. |
| Entry is `missing` | Inspect Git registration and stored path/identity. `add` will not recreate it. Preserve the registration until ownership and a recovery plan are clear. |
| Lock remains after interruption | Read the lock owner and confirm that process has stopped before removing only the stale lock directory. Preserve locks held by live processes. |

Locate shared state from any worktree with:

```sh
git rev-parse --path-format=absolute --git-common-dir
```

Under that directory, Workrex uses `workrex/state.json`, `workrex/lock/owner.json`, and `workrex/cleanup.log`. The log records deferred tab-cleanup failures. These are runtime bookkeeping, not configuration. Prefer the supported retry commands; hand-editing the registry or deleting owned paths bypasses identity and commit-safety checks.
