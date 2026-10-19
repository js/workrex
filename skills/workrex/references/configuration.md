# Workrex configuration

## Scope and inheritance

Both files are optional JSON objects (not JSONC):

| Scope | Path |
| --- | --- |
| Global | `$XDG_CONFIG_HOME/workrex/config.json` when `XDG_CONFIG_HOME` is nonempty; otherwise `~/.config/workrex/config.json` |
| Project | `<primary-checkout>/.workrex.json`, shared by that repository's worktrees |

Use `git worktree list --porcelain` in the target repository to locate the primary checkout (first entry). Reading or editing a linked worktree's `.workrex.json` does not change the configuration Workrex uses.

Precedence is **built-in defaults → global → project**:

- Omitted fields inherit; `panes` replaces the entire layout, not individual panes.
- `files.copy` and `files.symlink` replace their lists **independently**. `files: {}` preserves both inherited lists.
- Use `[]` to clear a file list. To extend an inherited list, write the complete desired list at the overriding scope.
- Remove an override to resume inheritance. Removing project `main_branch` exposes any global value; it only returns to auto-detection when neither layer sets it. `null` is not a general reset mechanism.
- Global changes can be masked by project overrides. Explain that rather than silently changing both scopes.

Preserve unrelated keys and formatting where practical. A new file needs only the requested overrides, not a copy of every default. Share project settings by committing `.workrex.json` when requested; for local-only settings use the shared Git exclude file (`git rev-parse --path-format=absolute --git-path info/exclude`) rather than changing the team's `.gitignore`. Do not stage settings or secrets as a side effect of configuration.

## Supported fields

Unknown settings are rejected. There are no configurable hooks, worktree-directory templates, or layouts with more than two panes in the current schema.

| Field | Constraints | Default |
| --- | --- | --- |
| `panes` | Array of one or two pane objects | `nvim .` then `pi` |
| `panes[].command` | Required nonempty array of nonempty strings | See built-in layout below |
| `panes[].focus` | Boolean; at most one `true` | First pane if none selected |
| `panes[1].split` | `"horizontal"` = side by side; `"vertical"` = stacked | `"horizontal"` |
| `panes[1].percentage` | Integer 1–99; **second pane's** share | `40` |
| `files.copy` | Array of relative file/directory paths | `[]` |
| `files.symlink` | Array of relative file/directory paths | `[]` |
| `main_branch` | Nonempty string naming an existing local branch | Auto-detected |

Only the second pane accepts `split` and `percentage`. The built-in layout is:

```json
{
  "panes": [
    { "command": ["nvim", "."] },
    { "command": ["pi"], "split": "horizontal", "percentage": 40, "focus": true }
  ]
}
```

Commands run in the worktree through Rex's default interactive shell; that shell remains after the command exits. Use argv arrays such as `["npm", "run", "dev"]`, not `["npm run dev"]`. Arguments are literal: use `["sh", "-c", "npm install && npm run dev"]` when shell expansion or operators are intentional. Check executable availability rather than substituting or installing tools without agreement.

## File rules

Rules use literal relative paths, not globs. Sources come from the primary checkout, destinations use the same path in a **new** worktree. Missing sources are skipped.

- Copy once for independent files such as `.env`; symlink only when changes should be shared with the primary checkout.
- Ignore destinations in Git, especially secrets. Check whether paths are already tracked and whether the intended destination branch ignores them; an existing tracked destination will block setup. Do not read secret contents to check file presence.
- Paths cannot be absolute or contain empty, `.`, `..`, or `.git` components. Sources must resolve inside the primary checkout.
- Active rules cannot duplicate or contain one another across either list. Existing destinations are rejected rather than overwritten.
- Copy sources cannot contain symlinks or Git metadata. Dependency directories such as `node_modules` commonly need a symlink rule instead. Explain that installing dependencies through that link changes the primary checkout too.

## Default branch

`main_branch` controls the default **merge target** and `rm`'s merged-commit check, not the starting point for `add`. Without it, Workrex tries the existing local branch named by recorded `origin/HEAD`, then local `main`, then local `master`. It does not fetch. `wr merge --into <target>` overrides this for one merge only.

A global `main_branch` must exist in each repository where it is used; prefer a project override for repositories with different branch conventions.

## Examples

**Project: inherit panes, copy `.env`, clear global symlinks, merge into `develop`.** Confirm `develop` exists locally first. Set `<primary>/.workrex.json` to these overrides, preserving any other requested settings:

```json
{
  "main_branch": "develop",
  "files": { "copy": [".env"], "symlink": [] }
}
```

Omit `symlink` instead if the user wants to keep the global symlink rules.

**Global: editor above agent, agent gets 60% and focus.** Update only `panes` in the global file:

```json
{
  "panes": [
    { "command": ["nvim", "."] },
    { "command": ["pi"], "split": "vertical", "percentage": 60, "focus": true }
  ]
}
```

A project with its own `panes` remains unchanged. To use one pane, replace the full array with `[{"command":["pi"]}]`.

## Read-only validation

Workrex has no `config check`, `config set`, or dry-run CLI. Validate with the installed loader rather than inventing one or using `add` as a probe.

Resolve the installed `wr` symlink to its checkout; set `workrex` to that directory (containing `src/config.ts` and `src/repo.ts`), and `checkout` to the target repository or any of its worktrees. Then run:

```sh
bun -e '
const { config, fileRules } = await import(process.argv[1] + "/src/config.ts");
const { Repo } = await import(process.argv[1] + "/src/repo.ts");
const repo = new Repo(process.argv[2]);
const cfg = config(repo.primary);
const activeRules = fileRules(repo.primary, cfg);
if (cfg.main_branch !== undefined) repo.defaultBranch(cfg.main_branch);
console.log(JSON.stringify({ primary: repo.primary, effective: cfg, activeRules }, null, 2));
' "$workrex" "$checkout"
```

This reads the registry/config and inspects source paths without creating worktrees, copying files, launching panes, or connecting to Rex. Missing source rules appear in `effective` but not `activeRules`. It checks an explicit `main_branch`; for a merge/remove with auto-detection, also resolve the actual target. It does not prove future destinations are free, executables work, or every other repository accepts a global setting.

If the installed source is unavailable or has changed, inspect its current documentation/schema, check JSON syntax and the constraints above, and state the validation limitation. Do not claim a full validation from JSON parsing alone.
