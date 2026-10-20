---
name: workrex
description: Use Workrex (wr) to create, open, reopen, list, merge, or remove Git worktrees in Rex tabs. Use when adjusting Workrex pane commands/layouts, copy/symlink rules, or main_branch in per-project .workrex.json or global workrex/config.json, and when troubleshooting Workrex setup or interrupted operations.
---

# Workrex

`wr` owns the Git worktree lifecycle and its Rex tab. Use it for registered worktrees; use Rex directly for inspecting or arranging existing tabs, not as a substitute for Workrex's bookkeeping.

## Locate the target

1. Run `command -v wr` and `wr --help` to check the installed executable and supported commands. Workrex requires Bun, Git, and Rex. For missing commands or Lua actions, read [setup and recovery](references/setup-recovery.md).
2. In the requested repository, run `git worktree list --porcelain` and `git status --short`. The first worktree is the **primary checkout**; `git rev-parse --show-toplevel` only identifies the invoking checkout. Workrex supports local, non-bare repositories.
3. For lifecycle work, run `wr ls` to find registered branches and their paths, tab status, and phase. This lists Workrex entries, not all Git worktrees. `wr open <branch>` registers an existing checkout that is missing from that list. For config-only work, skip Rex inspection and read [configuration](references/configuration.md).
4. Before opening a tab, select the intended Rex session. Normally use inherited `REX_SESSION`. If absent or stale, use the Rex skill, or `rex whoami --json` then `rex ls --json`, to discover full IDs. Ask if the target is ambiguous. Scope an explicit override to the command: `REX_SESSION='full-session-id' wr add <name>` or `wr open <branch>`.

## Create or reopen

```sh
wr add fix-login
wr add fix-settings --branch develop
wr open old-fix
wr ls
```

- New branches start at the **invoking checkout's HEAD**, not automatically at `main_branch`. `--branch` selects an existing local source branch; Workrex never fetches or pulls.
- An existing local branch keeps its commits. Pass `--branch` only for a new branch and unregistered worktree; it cannot reset an existing branch or retarget a registered worktree.
- Repeating `add` or `open` focuses an open tab or recreates a closed tab. Neither reapplies file rules, rebuilds an open layout, or restores a missing directory.
- `wr open <branch>` takes the branch name of an existing linked worktree, not a path. It uses merged global and primary-checkout project config without creating a worktree or applying file rules. Configured pane commands run in the worktree as usual.
- Worktrees created outside `wr` are registered as `external`, or shown as `missing` if their directory is gone. `merge` refuses them. `rm` only closes their tab and forgets the entry, even with `--force`. Their files and branches remain. For failed or deferred tab closure, follow [recovery](references/setup-recovery.md).
- Worktrees created with `add` are placed beside the primary checkout in `<repo>__worktrees/<encoded-branch>`. Read the reported path rather than constructing it. `/` in branch names is encoded as `%2F`.
- Tabs default to `<repo>/<branch>` but are tracked by window ID, not title. Renaming a tab is safe.

Verify the reported path and `wr ls` state. When layout or command startup matters, inspect the registered session/window through Rex and capture the relevant panes. An open tab alone does not prove its commands succeeded. Creating a tab may succeed even if automatic switching fails.

## Adjust configuration

Read [configuration](references/configuration.md) before editing either scope. It contains the schema, merge rules, examples, and a read-only validation command.

1. Identify **project** versus **global** intent. Ask when unclear; a global edit affects other repositories. Find both files and read their existing values before choosing an edit.
2. Change only the requested scope and fields. Project settings come from the primary checkout, even when invoked in a linked worktree. Preserve omitted fields so they continue inheriting.
3. Validate the resulting effective config with the installed loader, plus branch and file-rule checks. Report any checks that could not run. `wr ls` does **not** validate config; creating a disposable worktree is not a read-only validation method.
4. Report the changed file, effective behavior, and when it applies. JSON config is read on subsequent relevant commands; no Rex reload is needed. Pane changes apply to new/reopened tabs, file rules only to newly created worktrees. Preserve running tabs unless the user requested restarting them.

## Merge or remove

Both commands require the registered branch name, even from inside that worktree:

```sh
wr merge fix-login
wr merge fix-settings --into develop
wr rm abandoned-work
```

Before acting, inspect the source worktree's status and outstanding Git operations. Resolve the merge target from `--into`, configured `main_branch`, or local default-branch detection; inspect that target checkout too. Use `git log <target>..<source> --oneline` to identify commits at stake. A missing local target is a reason to stop, not to silently fetch or create one.

- If `wr ls` shows `external`, do not merge or delete that worktree. Follow the `open` rules above.
- `merge` rebases source onto target, fast-forwards target, then removes the source worktree, branch, and tab. It rewrites source history; a request to merge without rebasing needs a different workflow agreed with the user. A dirty target blocks it. Without a target checkout, it updates the target ref without switching the primary checkout's branch.
- `rm` removes without merging. Normally it refuses dirty work and commits not merged into the default branch. Even ordinary successful cleanup deletes the worktree's ignored files; identify anything the user needs to retain.
- **Require explicit authorization to discard work before using `--force`.** A refusal is not permission to retry with force. Show the affected branch/path and changes first.
- `merge --force` discards staged/unstaged tracked changes and non-ignored untracked files before rebasing; it neither commits nor stashes. Ignored files are deleted with successful worktree cleanup. Dirty targets and unfinished operations still block it.
- `rm --force` abandons the whole worktree, including ignored files and unfinished Git operations.

After a successful `merge`, verify the target commit. After `merge` or `rm` of a worktree that `wr` created, confirm the source is gone from `git worktree list` and `wr ls`. After `rm` of an external entry, confirm the entry is gone from `wr ls` and that the Git worktree and branch are still present. Closing the invoking tab is deferred. For a worktree that `wr` created, that close waits until Git cleanup finishes. If the tab stays open, follow [recovery](references/setup-recovery.md). Report failures rather than manually deleting branches, directories, or registry entries to bypass them.
