# workrex

`wr` creates Git worktrees and opens each in a Rex tab. Run `wr add new-feature` to start your editor and coding agent side by side. Configure other pane commands, copy `.env`, or symlink `node_modules` from your primary checkout.

[workmux](https://github.com/raine/workmux) for tmux inspired this tool. Thanks to workmux's authors and contributors.

## Install

`wr` requires Bun, Git, and Rex but has no runtime package dependencies. Install `nvim` and `pi` for the default panes, or [configure your own commands](#panes). Checking out GitHub PRs also requires an authenticated GitHub CLI (`gh auth login`) with `gh pr checkout --worktree` support.

From this checkout, link the executable:

```sh
mkdir -p "$HOME/.local/bin"
ln -s "$PWD/wr" "$HOME/.local/bin/wr"
```

Add `~/.local/bin` to your `PATH`. For Fish completions, create `~/.config/fish/completions/wr.fish` containing `wr completions fish | source`.

Generate the Lua config with this checkout's path:

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

Run `add` or `open` inside a Rex terminal so they can use `REX_SESSION`. Other commands find tabs through the repo's registry. Rex must be reachable for tab operations. For automatic tab switching, enable Remote Control under Rex Server in Rex's Settings.

## Agent skill

[skills/workrex](skills/workrex/SKILL.md) teaches coding agents how to use `wr`, change global and per-project config, validate settings without opening tabs, and recover interrupted operations.

From this checkout, install it for agents that load `~/.claude/skills`:

```sh
mkdir -p "$HOME/.claude/skills"
ln -s "$PWD/skills/workrex" "$HOME/.claude/skills/workrex"
```

Inspect any existing skill at that path before replacing it. The symlink keeps the skill aligned with this checkout. Start a new agent session if it is not discovered automatically.

## Create and list worktrees

```sh
wr add fix-login
wr add fix-settings --branch develop
wr add --pr 830
wr open old-fix
wr ls
```

New branches start at the invoking checkout's HEAD unless you pass `--branch` or `--pr`. Existing branches keep their commits. `--branch` cannot reset them.

`wr add --pr 830` uses `gh` to look up PR #830 in the current repository and check it out in a new worktree, including fetching fork PRs. It names the local branch and worktree `pr-<number>-<headRefName>` (for example, `pr-830-feature/login`), applies the usual copy/symlink rules and merged Workrex pane config, and leaves the invoking checkout unchanged. Use `wr add review-830 --pr 830` to choose an exact local branch name without the automatic prefix. `--pr` takes a positive PR number and cannot be combined with `--branch`.

If that name is already registered, `--pr` reopens it without fetching, resetting local work, or reapplying file rules. Older unprefixed worktrees are not renamed; reopen them with `wr open <old-name>` or `wr add <old-name> --pr <number>`. An unregistered existing branch or worktree is never updated: choose another name, or use ordinary `add`/`open` to keep its current commits.

Worktrees created with `add` live beside the primary checkout in `<repo>__worktrees/`. Branch names become directory names, with `feature/login` encoded as `feature%2Flogin`.

Tabs are named `<repo>/<branch>`. `wr` tracks them by their Rex window IDs, so you can rename them.

Repeat `add` or `open` to focus an existing tab, even in another Rex session. If the saved tab or session is gone, `wr` creates a new tab in your current session and saves its IDs after Rex confirms it. Neither command reapplies file rules or recreates a missing worktree.

`open` takes a registered name from `wr ls`, or the current branch name of an unregistered linked worktree. It does not take a path. Registered names keep working after you switch branches inside the worktree. Opening does not update the registered branch, and `merge` and `rm` still refuse a managed worktree whose branch changed. It uses the merged global and primary-checkout project config. It does not create a worktree or apply copy and symlink rules. Configured pane commands run in the worktree as usual.

Worktrees created outside `wr` are listed as `external`. For these, `wr rm` only closes the tab and forgets the entry, even with `--force`. The worktree and branch remain. `wr merge` refuses external worktrees.

`ls`, also spelled `list`, shows this repo's registered worktrees in aligned columns: `WORKTREE`, `TAB`, and `STATE`, including closed tabs and missing directories. `WORKTREE` is the registered name, followed by ` [branch-name]` only when the current Git branch differs (for example, `swift [new/topic]`). Detached HEADs append ` [(detached)]`; unavailable branch information appends ` [-]`. With `wr ls --verbose`, the registered name is shown without the bracketed suffix, and the branch and path appear in separate `BRANCH` and `PATH` columns.

## Configure

### Global and per-project settings

Both config files are optional JSONC objects with the same options. They accept ordinary JSON, `//` line comments, `/* ... */` block comments, and trailing commas:

| Scope | Location |
| --- | --- |
| Global, for all repos | `~/.config/workrex/config.jsonc` |
| Project, for one repo and its worktrees | `.workrex.jsonc` in the primary checkout |

If `XDG_CONFIG_HOME` is nonempty, the global path is `$XDG_CONFIG_HOME/workrex/config.jsonc`. Worktree commands always read project settings from the primary checkout, not the worktree where you run them.

Existing `config.json` and `.workrex.json` files still work and also accept comments. In each location, `.jsonc` takes precedence over `.json`. The two files are not merged. An invalid `.jsonc` file reports an error rather than falling back to `.json`.

Project settings override global settings. Unset fields use the global value, or the built-in default if neither file sets it. Each array replaces the inherited list. `panes` replaces the whole layout, while `files.copy` and `files.symlink` replace their lists independently. Use `[]` to clear a file list.

This project `.workrex.jsonc` keeps the inherited panes, copies `.env`, clears global symlink rules, and uses `develop` as the default branch:

```jsonc
{
  "main_branch": "develop",
  "files": {
    "copy": [".env"],
    "symlink": []
  }
}
```

Omit `files.symlink` to keep the global symlink rules instead. Commit `.workrex.jsonc` to share settings, or ignore it to keep them local and avoid untracked changes. `wr` rejects unknown options.

### Check config files

```sh
wr config check
```

Reports whether the global `config.jsonc` and `$CWD/.workrex.jsonc` exist and whether each is valid JSONC. It honors `XDG_CONFIG_HOME` for the global path and checks both files even if one fails. Missing files are optional and do not cause failure; invalid JSONC or a read error exits with status 1.

This is a syntax-only check of those two `.jsonc` files, not a validation of Workrex settings or legacy `.json` files. Unlike worktree commands, it checks the current directory rather than the primary checkout and works outside a Git repository.

### Options and defaults

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `panes` | Nonempty array of pane objects | See below | Commands and layout for new tabs |
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

The commented [examples/config.jsonc](examples/config.jsonc) adds a third pane that runs `bun run start:bff` below `pi`, as described in [Panes](#panes). It also adds a `.claude/settings.local.json` symlink rule. `wr` skips the rule if the source file is missing.

### Panes

`wr` builds the layout in list order. The first pane fills the tab. Each later pane splits an earlier pane in two and takes the right or bottom part.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `id` | Nonempty string | None | Name that later panes use in `split_from` |
| `command` | Nonempty string or nonempty array of nonempty strings | Required | Shell command or literal arguments, run in the worktree directory |
| `focus` | Boolean | `false` | Focus this pane when creating the tab |
| `split_from` | `id` of an earlier pane | The previous pane | Pane to split |
| `split` | `"horizontal"` or `"vertical"` | `"horizontal"` | Put this pane to the right of the split pane, or below it |
| `percentage` | Integer from 1 to 99 | `40` | This pane's share of the split pane's space |

The first pane cannot set `split_from`, `split`, or `percentage`. `id` values must be unique. At most one pane can set `focus: true`. If none does, the first pane gets focus.

This layout gives `nvim` the left 40 percent of the tab. `pi` gets focus and the top 72 percent of the right column, and `bun run start:bff` runs below it:

```json
{
  "panes": [
    { "command": "nvim ." },
    {
      "command": "pi",
      "split": "horizontal",
      "percentage": 60,
      "focus": true
    },
    {
      "command": "bun run start:bff",
      "split": "vertical",
      "percentage": 28
    }
  ]
}
```

`pi` sets `percentage` to 60 because it takes 60 percent of the width from `nvim`, which keeps the other 40. `bun run start:bff` then takes 28 percent of the height from `pi`. To split a pane other than the previous one, give that pane an `id` and refer to it with `split_from`. Several panes can split the same pane. Each takes its percentage of the space that pane has left.

Each pane starts Rex's default interactive shell and runs its command there. When the command exits, the shell stays open in the worktree.

A string such as `"bun install && bun run start:bff"` runs as written in Rex's configured shell. That shell interprets quotes, variables, wildcards, and operators. Use its syntax, which may differ from `sh`.

An array such as `["nvim", "notes with spaces.md"]` preserves each argument literally, without variable or wildcard expansion. Both forms can appear in the same layout. `["npm run dev"]` is one executable name, not three arguments.

Pane changes apply to new or reopened tabs. Repeating `add` for an open tab does not change its layout or restart commands.

After you update `wr`, run `rex config reload`. Rex keeps using the `rex/wr.lua` it loaded last, and versions before nested panes reject more than two panes.

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

For worktrees created with `wr add`, `merge` rebases the source branch onto the target, fast-forwards the target, then removes the source worktree, branch, and tab. A dirty target checkout blocks the merge. If the target has no checkout, `wr` updates its ref without switching branches in the primary checkout. The starting branch passed to `add --branch` does not change the merge target.

`rm` removes the worktree, branch, and tab without merging. It refuses dirty work or commits not merged into the default branch unless you pass `--force`. Removal prints each completed step: worktree removal, branch deletion, tab closure, and registry cleanup. Retries identify resources already removed. The same progress is shown during cleanup after `merge`; deferred tab cleanup writes its progress to `cleanup.log`. Use `wr rm <name> --verbose` to also announce each operation before it starts, including safety checks, so you can see what is running or where a failure occurred. It works with `--force` and carries through to deferred cleanup.

**Force deletes work without another prompt.**

```sh
wr merge fix-login --force
wr rm abandoned-work --force
```

- `merge --force` discards staged and unstaged tracked changes and removes non-ignored untracked files before rebasing. It does not commit or stash them. Ignored files survive until successful cleanup removes the worktree. It does not forcibly clean nested repositories or dirty submodules.
- `rm --force` abandons the whole worktree, including ignored files and an unfinished rebase or merge.
- `merge --force` still refuses dirty targets and unfinished Git operations.

For a worktree that `wr` created, commands finish Git cleanup before closing their own tab in the background. `rm` of an external worktree only closes the tab.

## Recovery

A rebase conflict leaves the worktree and tab open. Resolve and stage the changes in that worktree. Run `git rebase --continue`, or abort with `git rebase --abort`. Retry `wr merge <branch>` afterward. Finish or abort any Git operation before retrying a merge.

If `add` or `open` fails or is interrupted while opening a tab, inspect Rex before retrying. A tab may have opened without its window ID being saved. Close that tab manually, then retry the same command. `wr` does not find tabs by title.

If file setup fails, the entry stays `creating`. Inspect it, then use `wr rm <branch> --force` to abandon it before starting again.

If tab closure fails after Git cleanup, the entry stays `removing`. Retry `wr rm <branch>`. If closing an external tab fails, the entry stays `external`, and the same retry closes it. Background errors go to `cleanup.log` beside the registry.

The shared Git directory contains `workrex/state.json` and `workrex/lock`. The lock prevents concurrent `wr` changes. If a killed process leaves it behind, read `workrex/lock/owner.json` and confirm the process has stopped before removing the lock directory. Never remove a live process's lock.

Registrations use full worktree and Git directory paths. A directory recreated at the same paths keeps its registration. `wr` ignores legacy device/inode identities and drops them on the next registry save.

## Develop

```sh
bun install --frozen-lockfile
bun run check
bun test
```

Default tests use temporary Git repositories and fake Rex and GitHub CLI executables. `bun run test:rex` checks the live layout, shell prompts after commands exit, tab reopening, and cleanup from inside a tab. It creates and destroys its own Rex sessions and leaves `init.lua` unchanged.

To test the Lua module without installing or reloading it:

```sh
WR_LUA="$PWD/rex/wr.lua" ./wr add experiment
```

`wr` supports local, non-bare repositories and Rex tabs only. It was tested with Bun 1.4.2, Git 2.54.0, and Rex server `0.0.1792158932-g88fd41`.
