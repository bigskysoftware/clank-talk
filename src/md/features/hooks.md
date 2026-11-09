# Hooks

Users write hooks in AGENTS.talk (or a file it imports), for policy and security.

## Decisions

Approved:

- `before <step> ... end` and `after <step> ... end`.
- Steps: `read`, `write`, `append`, `replace`, `put`, `remove`, `run`, `git`, a tool name, and `change` for any file change.
- In a hook, a local variable with the step's name holds the step: `the write's path`, `the change's kind`.
- `reject <message>` in a `before` hook stops the step. The script gets an error with the message. `on error` can catch it.
- `after` hooks see `the result`.

- Step fields. File changes: `kind`, `path`, plus `text` (write, append), `old` and `new` (replace in a file), `from`, `to`, `text` (replace lines, remove), `line`, `where`, `text` (put). `read`: `path`, and `text` in an `after` hook. `run`: `program`, `args`. `git`: `operation` (such as `log`), and `args`, the full git argument list without the guards. A tool: `args`, `named`.
- Hooks run in the order they are defined, across all files.
- Hooks run for commands inside tools. Commands inside a hook do not run hooks, so a hook cannot loop on itself.
- `reject` is only allowed in a `before` hook.
- A reject error points at the script command it stopped, not at the hook.
- Other errors in a hook point at the hook's file.
- A hook for an unknown step is an error when AGENTS.talk loads.
- `run` is not allowed in a hook.
- A hook cannot change the step. A hook cannot change the result.

## Open questions

- Hook results: ask the user (needs `ask`).
- `fetch` steps, when fetch exists.
