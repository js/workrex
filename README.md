# workrex

`wr` manages local Git worktrees and their Rex tabs. It runs with Bun, Git, and Rex. There are no runtime package dependencies.

[workmux](https://github.com/raine/workmux) for tmux is the prior art and inspiration for workrex. Credit to workmux's authors and contributors.

## Install

From this checkout, link the executable and Lua module:

```sh
mkdir -p "$HOME/.local/bin" "$HOME/.config/rex"
ln -s "$PWD/wr" "$HOME/.local/bin/wr"
ln -s "$PWD/rex/wr.lua" "$HOME/.config/rex/wr.lua"
```

Add `~/.local/bin` to your `PATH`. Add this line to `~/.config/rex/init.lua`:

```lua
require("wr")
```

Reload the server configuration:

```sh
rex config reload
wr --help
```

Run `add` from a Rex terminal. It uses that terminal's `REX_SESSION`. Other commands find the associated tabs through the repo's registry. Rex must be reachable for commands that inspect or change tabs.

The default layout runs `nvim .` and `pi` side by side. The right pane gets 40 percent and focus. Install those programs or change the pane commands.

## Configure

Global settings live in `~/.config/workrex/config.json`. Repo settings live in `.workrex.json` in the primary checkout, even when you run `wr` from another worktree. Repo settings override global settings. Each configured array replaces its global counterpart. Commit or ignore `.workrex.json` so it does not make the merge target dirty.

[examples/config.json](examples/config.json) reproduces the editor/agent layout and `.claude/settings.local.json` symlink rule. Add only file rules whose sources exist in the primary checkout.

A repo configuration can copy `.env` and replace the global symlink list:

```json
{
  "files": {
    "copy": [".env"],
    "symlink": []
  }
}
```

Files are copied once. Symlinks keep pointing into the primary checkout. Existing destinations, overlapping rules, missing sources, and paths outside the checkout cause an error. Copies do not support symlinks inside the source; use a symlink rule instead. Ignore local file-rule destinations in Git if they should not make the worktree dirty.

Pane commands are argument arrays, not shell strings. Use `["sh", "-c", "your shell command"]` when shell syntax is necessary. Configure one or two panes. The second pane accepts `split` as `horizontal` or `vertical`, and `percentage` from 1 to 99. At most one pane can have `focus: true`.

An optional `main_branch` names the local default branch. Otherwise, `wr` checks the locally recorded `origin/HEAD`, then local `main`, then local `master`. It never fetches or pulls.

## Create and list worktrees

```sh
wr add fix-login
wr add fix-settings --branch develop
wr ls
```

Without `--branch`, a new branch starts at the invoking checkout's HEAD. An existing branch can get a worktree, but `--branch` never resets an existing branch.

Worktrees live beside the primary checkout in `<repo>__worktrees/`. Branch names are encoded as directory names, so `feature/login` uses `feature%2Flogin`.

Repeat `add` to focus the existing tab or reopen a closed tab. Files are not copied again. `wr` refuses to adopt worktrees it did not create.

`ls`, also spelled `list`, shows this repo's registered worktrees. Closed tabs and missing worktrees remain visible. A missing worktree is not silently recreated.

## Merge or remove work

Both commands require an explicit branch name, including when run from that worktree:

```sh
wr merge fix-login
wr merge fix-settings --into develop
wr rm abandoned-work
```

`merge` rebases onto the target and fast-forwards it. A dirty target checkout blocks the operation. The starting branch passed to `add --branch` does not change the default merge target. When the target has no checkout, `wr` updates its ref without switching the primary checkout's branch.

A successful merge removes the source worktree, branch, and tab. `rm` does the same without merging, but normally refuses dirty work or commits not merged into the default branch.

**Force deletes work without another prompt.**

```sh
wr merge fix-login --force
wr rm abandoned-work --force
```

- `merge --force` discards staged and unstaged tracked changes and removes non-ignored untracked files before rebasing. It does not commit or stash them. Ignored files survive until successful cleanup removes the entire worktree. Nested repositories and dirty submodules are not forcibly cleaned.
- `rm --force` abandons the whole worktree, including ignored files and an unfinished rebase or merge.
- `merge --force` never bypasses dirty-target checks or an unfinished Git operation.

When a command removes its own tab, it finishes Git cleanup first. A detached process closes the tab and removes the registration after the caller releases the repo lock.

## Recover from an interrupted command

A rebase conflict leaves the worktree and tab open. Resolve conflicts there, stage the resolution, and run `git rebase --continue`. Alternatively, run `git rebase --abort`. Then retry `wr merge` with the explicit branch name. `wr` refuses to start another merge while a Git operation is unfinished.

If Rex fails after `add` creates a worktree, repeat `add`. A failed file-copy step remains marked `creating`; inspect it and use explicit `rm --force` to abandon it before trying again.

If tab closure fails after Git cleanup, the entry remains marked `removing`. Retry `rm` with the same name. Background closure errors go to `cleanup.log` beside the registry.

The registry lives in the shared Git directory at `workrex/state.json`. A `workrex/lock` directory serializes repo mutations. If a killed process leaves the lock behind, read `lock/owner.json` and verify that the recorded process has stopped before manually removing that lock directory. Do not remove a live process's lock.

## Develop

Development checks use TypeScript and Bun type declarations:

```sh
bun install --frozen-lockfile
bun run check
bun test
bun run test:rex
```

The default tests exercise the executable against temporary Git repositories and a fake Rex executable. `test:rex` creates and destroys only its own Rex sessions. It checks the real layout, tab reopening, and merge/removal from inside the tab being closed. It does not modify `init.lua`.

To try the Lua file without installing or reloading it, set `WR_LUA` to its absolute path:

```sh
WR_LUA="$PWD/rex/wr.lua" ./wr add experiment
```

Validated with Bun 1.4.2, Git 2.54.0, and Rex server `0.0.1792158932-g88fd41`. This version supports local, non-bare repositories and Rex tabs only.
