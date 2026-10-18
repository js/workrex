# workrex

`wr` creates Git worktrees and opens each in a Rex tab. Run `wr add new-feature` to start your editor and coding agent side by side. Configure other pane commands, copy `.env`, or symlink `node_modules` from your primary checkout.

[workmux](https://github.com/raine/workmux) for tmux inspired this tool. Thanks to workmux's authors and contributors.

## Install

`wr` requires Bun, Git, and Rex but has no runtime package dependencies. Install `nvim` and `pi` for the default panes, or [configure your own commands](#panes).

From this checkout, link the executable:

```sh
mkdir -p "$HOME/.local/bin"
ln -s "$PWD/wr" "$HOME/.local/bin/wr"
```

Add `~/.local/bin` to your `PATH`. Generate the Lua config with this checkout's path:

```sh
printf 'package.path = "%s/rex/?.lua;" .. package.path\nrequire("wr")\n' "$PWD"
```

Add the output to your Rex config after any existing `package.path` setup. `rex config check` prints the config file on its `path:` line. Rex uses `REX_CONFIG` if set, otherwise `$XDG_CONFIG_HOME/rex/init.lua` or `~/.config/rex/init.lua`.

Remove any old `~/.config/rex/wr.lua` symlink so Rex does not load that copy instead. Check and reload:

```sh
rex config check
rex config reload
wr --help
```

Run `add` inside a Rex terminal so it can use `REX_SESSION`. Other commands find tabs through the repo's registry. Rex must be reachable for tab operations. For automatic tab switching, enable Remote Control under Rex Server in Rex's Settings.

## Create and list worktrees

```sh
wr add fix-login
wr add fix-settings --branch develop
wr ls
```

New branches start at the invoking checkout's HEAD unless you pass `--branch`. Existing branches keep their commits. `--branch` cannot reset them.

Worktrees live beside the primary checkout in `<repo>__worktrees/`. Branch names become directory names, with `feature/login` encoded as `feature%2Flogin`.

Tabs are named `<repo>/<branch>`. `wr` tracks them by their Rex window IDs, so you can rename them.

Repeat `add` to focus an open tab or reopen a closed one. It does not reapply file rules or recreate missing worktrees. `wr` refuses to adopt worktrees it did not create.

`ls`, also spelled `list`, shows this repo's registered worktrees, including closed tabs and missing directories.

## Configure

### Global and per-project settings

Both config files are optional JSON objects with the same options:

| Scope | Location |
| --- | --- |
| Global, for all repos | `~/.config/workrex/config.json` |
| Project, for one repo and its worktrees | `.workrex.json` in the primary checkout |

If `XDG_CONFIG_HOME` is nonempty, the global path is `$XDG_CONFIG_HOME/workrex/config.json`. `wr` always reads project settings from the primary checkout, not the worktree where you run it.

Project settings override global settings. Unset fields use the global value, or the built-in default if neither file sets it. Each array replaces the inherited list. `panes` replaces the whole layout, while `files.copy` and `files.symlink` replace their lists independently. Use `[]` to clear a file list.

This project `.workrex.json` keeps the inherited panes, copies `.env`, clears global symlink rules, and uses `develop` as the default branch:

```json
{
  "main_branch": "develop",
  "files": {
    "copy": [".env"],
    "symlink": []
  }
}
```

Omit `files.symlink` to keep the global symlink rules instead. Commit `.workrex.json` to share settings, or ignore it to keep them local and avoid untracked changes. `wr` rejects unknown options.

### Options and defaults

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `panes` | Array of one or two pane objects | See below | Commands and layout for new tabs |
| `files.copy` | Array of relative paths | `[]` | Copy files or directories from the primary checkout |
| `files.symlink` | Array of relative paths | `[]` | Link files or directories to the primary checkout |
| `main_branch` | Nonempty string | Auto-detected | Default merge target and branch used by `rm` to check for unmerged commits |

The built-in config runs `nvim .` and `pi` side by side, with 40 percent of the space and focus on `pi`:

```json
{
  "panes": [
    { "command": ["nvim", "."] },
    {
      "command": ["pi"],
      "split": "horizontal",
      "percentage": 40,
      "focus": true
    }
  ],
  "files": {
    "copy": [],
    "symlink": []
  }
}
```

[examples/config.json](examples/config.json) adds a `.claude/settings.local.json` symlink rule. `wr` skips it if the source file is missing.

### Panes

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `command` | Nonempty array of nonempty strings | Required | Executable and arguments, run in the worktree directory |
| `focus` | Boolean | `false` | Focus this pane when creating the tab |
| `split` | `"horizontal"` or `"vertical"` | `"horizontal"` | Side by side or stacked top to bottom |
| `percentage` | Integer from 1 to 99 | `40` | Second pane's share of the split |

Only the second pane accepts `split` and `percentage`. At most one pane can set `focus: true`. If none does, the first pane gets focus.

Each pane starts Rex's default interactive shell and runs its command there. When the command exits, the shell stays open in the worktree.

Use argument arrays such as `["npm", "run", "dev"]`, not `["npm run dev"]`. Arguments are quoted literally. For shell syntax or variable expansion, use `["sh", "-c", "your shell command"]`.

Pane changes apply to new or reopened tabs. Repeating `add` for an open tab does not change its layout or restart commands.

### File rules

Paths name files or directories relative to the primary checkout, not glob patterns. Each destination uses the same relative path in the new worktree.

Copies happen once at worktree creation and remain independent. Symlinks share the source, so changes through a linked `node_modules` affect the primary checkout too.

`wr add` skips copy and symlink rules whose sources are missing. For the remaining rules, `wr` rejects existing destinations and overlaps. Sources must resolve inside the primary checkout. Paths cannot be absolute or contain `.`, `..`, or `.git` components. Copy sources cannot contain symlinks or Git metadata. Use a symlink rule for directories containing symlinks.

Ignore rule destinations in Git, especially `.env`, to avoid accidental commits and untracked changes.

### Default branch

`main_branch` must name an existing local branch. If omitted, `wr` tries the local branch named by the recorded `origin/HEAD`, then `main`, then `master`. It errors if none exists and never fetches or pulls. `wr merge --into` overrides the default for that merge.

## Merge or remove work

Both commands require a branch name, even when run from that worktree:

```sh
wr merge fix-login
wr merge fix-settings --into develop
wr rm abandoned-work
```

`merge` rebases the source branch onto the target, fast-forwards the target, then removes the source worktree, branch, and tab. A dirty target checkout blocks the merge. If the target has no checkout, `wr` updates its ref without switching branches in the primary checkout. The starting branch passed to `add --branch` does not change the merge target.

`rm` removes the worktree, branch, and tab without merging. It refuses dirty work or commits not merged into the default branch unless you pass `--force`.

**Force deletes work without another prompt.**

```sh
wr merge fix-login --force
wr rm abandoned-work --force
```

- `merge --force` discards staged and unstaged tracked changes and removes non-ignored untracked files before rebasing. It does not commit or stash them. Ignored files survive until successful cleanup removes the worktree. It does not forcibly clean nested repositories or dirty submodules.
- `rm --force` abandons the whole worktree, including ignored files and an unfinished rebase or merge.
- `merge --force` still refuses dirty targets and unfinished Git operations.

Commands finish Git cleanup before closing their own tab in the background.

## Recovery

A rebase conflict leaves the worktree and tab open. Resolve and stage the changes in that worktree. Run `git rebase --continue`, or abort with `git rebase --abort`. Retry `wr merge <branch>` afterward. Finish or abort any Git operation before retrying a merge.

If `add` fails or is interrupted while opening a tab, inspect Rex before retrying. A tab may have opened without its window ID being saved. Close that tab manually, then retry `add` to reuse the worktree. `wr` does not find tabs by title.

If file setup fails, the entry stays `creating`. Inspect it, then use `wr rm <branch> --force` to abandon it before starting again.

If tab closure fails after Git cleanup, the entry stays `removing`. Retry `wr rm <branch>`. Background errors go to `cleanup.log` beside the registry.

The shared Git directory contains `workrex/state.json` and `workrex/lock`. The lock prevents concurrent `wr` changes. If a killed process leaves it behind, read `workrex/lock/owner.json` and confirm the process has stopped before removing the lock directory. Never remove a live process's lock.

## Develop

```sh
bun install --frozen-lockfile
bun run check
bun test
```

Default tests use temporary Git repositories and a fake Rex executable. `bun run test:rex` checks the live layout, shell prompts after commands exit, tab reopening, and cleanup from inside a tab. It creates and destroys its own Rex sessions and leaves `init.lua` unchanged.

To test the Lua module without installing or reloading it:

```sh
WR_LUA="$PWD/rex/wr.lua" ./wr add experiment
```

`wr` supports local, non-bare repositories and Rex tabs only. It was tested with Bun 1.4.2, Git 2.54.0, and Rex server `0.0.1792158932-g88fd41`.
