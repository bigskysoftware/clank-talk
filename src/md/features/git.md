# Git

Approved.

A hardened git, so agents can use git without a general `run`. Human decision: real git, hardened (not a pure-JS git). See the analysis below.

## The problem

Git runs programs from its config and from files in the project. Researched in git 2.56 (`git help config`, `git help hooks`):

- Hook files: `.git/hooks/<event>`, or the folder that `core.hooksPath` names.
- Config hooks (new): `hook.<name>.command` with `hook.<name>.event`. Tested: `core.hooksPath=/dev/null` with `commit --no-verify` does not stop them. A config hook on `post-commit` still ran. Only `-c hook.<event>.enabled=false` for each event stopped it.
- Config that names a program: `core.fsmonitor`, `core.pager`, `pager.<cmd>`, `core.editor`, `sequence.editor`, `core.sshCommand`, `core.gitProxy`, `core.askPass`, `core.alternateRefsCommand`, `credential.helper`, `diff.external`, `diff.<driver>.command`, `diff.<driver>.textconv`, `filter.<driver>.clean`, `filter.<driver>.smudge`, `filter.<driver>.process`, `gpg.program`, `gpg.<format>.program`, `gpg.ssh.defaultKeyCommand`, `uploadpack.packObjectsHook`, `gc.recentObjectsHook`, `alias.*` (a `!` alias runs a shell), and the `*tool*` settings for difftool and mergetool.
- Files in the project that pick a driver: `.gitattributes` (filters, diff drivers) and `.gitmodules`.
- Environment: `GIT_*` variables, for example `GIT_EXTERNAL_DIFF`, `GIT_SSH_COMMAND`, `GIT_PAGER`, `GIT_EDITOR`, `GIT_CONFIG_*`.

I am not certain this list is complete. Check it again against the git docs for each new git version.

What already protects us: scripts cannot write hidden files, so a script cannot change `.git/`, `.gitattributes` or `.gitmodules`. See [../infrastructure/security.md](../infrastructure/security.md). A `run` program can still change them.

## The design

- Approved: git is built in. The agent never builds a git argument list. Each git operation is a fixed list of arguments, with typed values from the agent.
- Approved: the operations, first version:
  - read: status, diff, log, show, branch list, current branch
  - write: switch to a branch, make a branch, add files, commit
  - push: a separate step, so a hook can ask the human
- Approved: values from the agent are checked. Paths are project paths, and they go after `--`. Branch names must match a strict pattern (letters, digits, `-`, `_`, `/`, `.`), and must not start with `-`. A commit message is one argument (`-m`).
- Approved: before each call, read the repo config (`git config list --local --show-scope`, and the worktree config). If it sets any key from the list above, refuse, and name the key. Config from the user (global, system) is trusted: the agent cannot change it.
- Approved: each call also overrides the dangerous keys, as a second guard:
  - `-c core.hooksPath=/dev/null`, and `-c hook.<event>.enabled=false` for every hook event
  - `-c core.fsmonitor=false`, `--no-pager`, `-c core.editor=false`, `-c sequence.editor=false`, `-c protocol.ext.allow=never`, `-c gc.auto=0`, `-c credential.helper=`
  - not `-c diff.external=`: tested, git then tries to run a program with an empty name, and diff fails. `--no-ext-diff` is the guard.
  - `--no-ext-diff` and `--no-textconv` for diff, log and show; `--no-verify` for commit
- Approved: the child gets a clean environment: `PATH` and `HOME` only, plus `GIT_TERMINAL_PROMPT=0`. No `GIT_*` from outside.
- Approved: push keeps the user's global config, so their name, credentials and ssh settings work. Repo config must not set `core.sshCommand`, `credential.helper` or a remote URL with `ext::`.
- Approved: hooks in AGENTS.talk can watch git with `before git` and `after git`. The step has the operation, such as `commit`, and its values. Default: no hook.

## Code

`src/js/git.js` holds the guards, with no language parts: `unsafeConfig`, `guardArgs`, `gitEnv`, and the name checks. `test/git.test.js` checks with real git that the guards stop a config hook.

## Syntax

- Approved: git is a set of built-in commands that start with `git`, not tools.
- Approved: `git status`, `git diff <path>`, `git switch to <branch>`, `git commit <files> with <message>`.
- Approved: no push in the first version. Push comes later, with the approval design.
- Approved (built): `git push` runs `push --no-verify origin HEAD`: the current branch, to a branch with the same name on origin. Never force.
- Approved (built): push asks the human first (`Push branch 'x' to origin?`, yes or no), through `ask`. With no `yes`, nothing is pushed, and the error names the `allow git push` line.
- Approved (built): `git delete branch <branch>` runs `branch --delete <branch>`, so git deletes only a branch that is merged. Never `--force`.
- Approved (built): `allow git push` in AGENTS.talk lets push go without asking. Only AGENTS.talk can have it.
- Approved (built): push keeps the user's credential helper (from their global config), and gets `SSH_AUTH_SOCK` for their ssh agent. Repo config with a `pushurl` that starts with `ext::` is refused too.
- Approved (built): `git merge <branch>` is `merge --ff-only <branch>`. It never makes a commit, so it needs no message and cannot conflict. If a fast-forward is not possible, it is an error.
- Approved (built): repo config with `merge.<driver>.driver` is refused too: a merge driver runs a program.
- Approved, for the rest of the first version:
  - `git diff` with no path: all changes
  - `git log`, and `git log 20` for the last 20 commits
  - `git show <commit>`
  - `git branches`: the list of branches; `git branch`: the current branch
  - `git switch to new branch <branch>`: make a branch and switch to it
  - no `git add`: `git commit` takes the files, so the agent cannot commit files it did not name
- Approved: each command puts its output in the result, as text, like a tool's `output`. Later: values, such as a list of changed files.
- Approved (built): `git status` is `status --short --branch`. `git log` shows 15 commits with `--oneline`. A git call that fails is a script error with git's message. `git diff` with an empty list of files is an error, because no files would mean the diff of everything.
- Approved (built): `git switch to <branch>` is `switch <branch>`, and `git switch to new branch <branch>` is `switch --create <branch>`.
- Approved (built): `git commit <files> with <message>` runs `add -- <files>`, then `commit --no-verify --no-gpg-sign --message=<message> -- <files>`. Thus the commit has only the named files, even if other files are staged. A hidden file, such as `.env`, cannot be committed unless AGENTS.talk allows changes to it.
- Approved: `git` is one command word. The words after it pick the operation, so `git` needs no change to the follows set except `with` in `git commit`.

## Later

- Clone and fetch. They run code from the remote (protocol helpers, `uploadpack.packObjectsHook` for local paths). They run code from the remote (protocol helpers, `uploadpack.packObjectsHook` for local paths).

## Limits

- A `run` program, for example `npm test`, can still change `.git/`. The config check before each call catches most of this. Only an OS sandbox closes it.
- Filters and helpers in the user's global config still run. They are the user's.
