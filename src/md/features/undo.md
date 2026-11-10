# Undo

Approved. Code: the "undo" section of `src/js/runtime.js`.

Undo puts back the files that a script changed. It covers file changes only: `write`, `append`, `replace`, `put`, `remove`. It does not undo `run` programs, tools, or git commits. The audit records those.

## Syntax

- Approved: `undo` takes back all file changes of the last script that changed files. That script can be from an earlier call in the same session.
- Approved (built): in a script that changed files, `undo` takes back that script's own changes so far first. Thus `replace ... then run_tests, and if they fail, undo` works in one script. Changes after the undo go on the list at the end of the script.
- Approved: `undo 3` takes back the last 3 scripts that changed files, newest first.
- Approved: `undo changes to <file>` puts back one file, as it was before the last script that changed it.
- Approved: `the undo list` is a list of the scripts that undo can take back, newest first. Each item has `number` (1 is the newest), `time` and `files`. `print the undo list` shows one line for each.

## Rules

- Approved: if a file changed after the script that undo takes back (the human edited it, or a `run` program did), undo changes nothing. The error names each file that changed.
- Approved: a file that the script made is removed by undo.
- Approved (built): the result of `undo` is the list of files that it put back.
- Approved (built): undo does not record itself, so there is no redo yet. The host still sees undo's writes in `changes`, with `undo: true`.
- Approved (built): the host keeps the undo list for the session (`options.undo`), like `$` globals. The list keeps the last 20 scripts. Older ones are dropped. A script that fails part way is on the list too.
- Approved (built): undo uses the same file checks as a write: the root, `.talk` files, hidden files.
- Approved (built): undo runs the `undo` and `change` hooks, with `kind` `undo` and the new `text` (null for a removed file), so a hook can watch or reject it.
- Limit: hooks run for each file. If a hook rejects the second file, the first file is already put back.
