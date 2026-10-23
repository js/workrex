import { realpathSync } from "node:fs";
import { present } from "./config";
import { git, Repo, worktrees } from "./repo";

export type NameKind = "registered" | "open" | "branches";

const fishSource = String.raw`function __wr_names
    command wr __complete $argv 2>/dev/null
end

function __wr_candidates
    set -l tokens (commandline -opc)
    if test (count $tokens) -lt 2
        printf '%s\n' add open merge rm ls list config completions
        return
    end

    set -l sub $tokens[2]
    set -l positionals 0
    set -l taking ""
    set -l ended 0
    set -l token
    set -l i 3
    while test $i -le (count $tokens)
        set token $tokens[$i]
        if test -n "$taking"
            set taking ""
        else if test $ended -eq 1
            set positionals (math $positionals + 1)
        else if test "$token" = --
            set ended 1
        else if test "$token" = --into
            set taking into
        else if test "$token" = --branch
            set taking branch
        else if test "$token" = --pr
            set taking pr
        else if string match -q -- '-*' "$token"
            true
        else
            set positionals (math $positionals + 1)
        end
        set i (math $i + 1)
    end

    switch "$sub/$taking"
        case add/branch merge/into
            __wr_names branches
            return
    end
    if test -n "$taking"
        return
    end

    set -l current (commandline -ct)
    if test $ended -eq 0; and string match -q -- '-*' "$current"
        switch $sub
            case add
                printf '%s\n' --branch --pr
            case merge
                printf '%s\n' --into --force
            case rm
                printf '%s\n' --force --verbose
            case ls list
                printf '%s\n' --verbose
        end
        return
    end
    if test $positionals -gt 0
        return
    end

    switch $sub
        case add merge rm
            __wr_names registered
        case open
            __wr_names open
        case config
            printf '%s\n' check
        case completions
            printf '%s\n' fish
    end
end

complete -c wr -e
complete -c wr -f -k -a '(__wr_candidates)'
`;

export function fishScript(): string {
  return fishSource;
}

export function completionNames(cwd: string, kind: NameKind): string[] {
  try {
    const repo = new Repo(cwd);
    if (kind === "branches") {
      return git(repo.primary, ["for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads"])
        .out.split("\n").filter(Boolean);
    }

    const names = new Set(repo.entries.map((entry) => entry.branch));
    if (kind === "open") {
      const ownedPaths = new Set(repo.entries.map((entry) => entry.path));
      for (const wt of worktrees(repo.primary)) {
        if (wt.branch === null || wt.locked || ownedPaths.has(wt.path)) {
          continue;
        }
        try {
          if (present(wt.path) && realpathSync(wt.path) !== repo.primary) {
            names.add(wt.branch);
          }
        } catch {
          continue;
        }
      }
    }
    return [...names];
  } catch {
    return [];
  }
}
