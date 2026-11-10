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
- Approved (built): push does not ask the human. It sends only the current branch to origin, never with force, so it cannot rewrite or delete work on the remote. A policy can turn it off with `deny git push`. Why: the question added a step to every push, and the risk is small. Before: push asked, unless AGENTS.talk had `allow git push`; that line is gone.
- Approved (built): `git delete branch <branch>` runs `branch --delete <branch>`, so git deletes only a branch that is merged. Never `--force`.
- Approved (built): push keeps the user's credential helper (from their global config), and gets `SSH_AUTH_SOCK` for their ssh agent. Repo config with a `pushurl` that starts with `ext::` is refused too.
- Approved (built): with the project root in a subfolder of a repo, `git status`, `git diff`, `git show` and `git log` get the pathspec `.`, so they cover only the root's files, as reads do. At the top of a repo nothing changes, because `git log -- .` there would hide merge commits.
- Approved (built): a push to a remote that is a folder inside the project is refused. Why: a remote folder runs its own hooks on a push, and the hardened settings do not reach it, so a script could write a hook there and run it. A remote folder outside the project is the human's, so a push to it works. The check uses each push URL of origin, before and after links.
- Approved (built): a branch name is text. A bare word that is no variable gives: `A branch name is text, in quotes: git switch to new branch 'fix-parser'`, for switch, merge, delete and rebase. A variable that holds the name still works.
- Approved (built): `git merge <branch>` is `merge --ff-only <branch>`. It never makes a commit, so it needs no message and cannot conflict. If a fast-forward is not possible, it is an error.
- Approved (built): repo config with `merge.<driver>.driver` is refused too: a merge driver runs a program.
- Approved (built): `git rebase onto <branch>` rebases the current branch onto the branch (`rebase --no-autosquash --no-autostash <branch>`). It is all or nothing: on a conflict, it runs `rebase --abort` and gives an error with the files in conflict, so the repo is never left in a rebase. It refuses with no current branch, onto the branch itself, with uncommitted changes to tracked files, and if the branch has commits on a remote, because a rebase rewrites them. No interactive mode and no `--exec`. After a rebase, run the tests before the merge.
- Approved (built): `git move <file> to <file>` runs `git mv -- <from> <to>`, so the history follows the file. One file, with the checks of a write for both paths (inside the project, no `.talk`, no `@/talk/`, no hidden files). It never replaces a file. It makes the folder of the new path. It is not in the undo list, as `git switch` and `git commit` are not.
- Approved (built): `git commit` adds only the named files that exist. A named file that is gone (moved or removed) is still in the commit, so git commits the rename or the removal.
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
- Approved: `git switch` and `git merge` can change `.talk` files, `@/talk/`, and hidden files. No extra check. Why: what is in git got there in a legitimate way. A script cannot commit these files, and a sandboxed program cannot write `.git/`, so a human put them there.
- Approved (built): `git commit <files> with <message>` runs `add -- <files>`, then `commit --no-verify --no-gpg-sign --message=<message> -- <files>`. Thus the commit has only the named files, even if other files are staged. A hidden file, such as `.env`, cannot be committed unless AGENTS.talk allows changes to it.
- Approved (built): `git commit` takes files, not folders: a folder can hold a hidden file. Every git call has `--literal-pathspecs`, so a path such as `:/` or `:(top).env` is only a file name, never pathspec magic.
- Approved: `git` is one command word. The words after it pick the operation, so `git` needs no change to the follows set except `with` in `git commit`.

## Later

- Clone and fetch. They run code from the remote (protocol helpers, `uploadpack.packObjectsHook` for local paths). They run code from the remote (protocol helpers, `uploadpack.packObjectsHook` for local paths).

## Limits

- A `run` program, for example `npm test`, can still change `.git/`. The config check before each call catches most of this. Only an OS sandbox closes it.
- Filters and helpers in the user's global config still run. They are the user's.
