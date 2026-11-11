# Hooks

Users write hooks in AGENTS.talk (or a file it imports), for policy and security.

## Decisions

Approved:

- `before <step> ... end` and `after <step> ... end`.
- Steps: `read`, `write`, `append`, `replace`, `put`, `remove`, `move`, `delete`, `undo`, `run`, `start`, `stop`, `git`, `fetch`, a tool name, and `change` for any file change.
- In a hook, a local variable with the step's name holds the step: `the write's path`, `the change's kind`.
- Approved (built): after `the`, a tool name is a variable, as a command word is. Thus a hook for a tool reads its step: `the deploy's args`. A bare `deploy` still calls the tool.
- Approved (built): a hook for a tool reads each parameter by its declared name: `tool deploy with target` gives `the deploy's target`, if the agent passes it by position or by name. A parameter that the agent does not pass is null. `args` and `named` stay. A tool parameter named `args` or `named` is an error when AGENTS.talk loads. Why: `the deploy's args contains 'prod'` searched a list, not the target.
- `reject <message>` in a `before` hook stops the step. The script gets an error with the message. `on error` can catch it.
- Approved (built): `reject <message>` also works in a tool. The tool stops, and the caller gets an error with the message, at the tool call. Why: a rule for one tool belongs in the tool, and a tool had no way to say no. A hook is still the place for a rule over a tool from another file, or over many steps.
- `after` hooks see `the result`.

- Step fields. File changes: `kind`, `path`, plus `text` (write, append), `old` and `new` (replace in a file), `from`, `to`, `text` (replace lines, remove), `line`, `where`, `text` (put), `to` (move). `read`: `path`, and `text` in an `after` hook. `run`: `program`, `args`, `sandbox`, `secrets` (the names from `using secret`). `git`: `operation` (such as `log`), and `args`, the full git argument list without the guards; `files` and `message` for commit, `branch` for switch and merge. `fetch`: `url`, `method`, `secrets` (a list of names), and `status` in an `after` hook. Hooks check `the session is untrusted` (see [taint.md](taint.md)); steps have no taint labels. `start`: `program`, `args`, `name`, `sandbox`, `secrets`. `stop`: `name`. For `run` and `start`, `sandbox` is null, or `{ network, reads, writes }`, so a hook can require a sandbox. A tool: `args`, `named`.
- Hooks run in the order they are defined, across all files.
- Hooks run for commands inside tools. Commands inside a hook do not run hooks, so a hook cannot loop on itself.
- `reject` is only allowed in a `before` hook or a tool.
- A reject error points at the script command it stopped, not at the hook.
- Other errors in a hook point at the hook's file.
- A hook for an unknown step is an error when AGENTS.talk loads.
- `run` is not allowed in a hook.
- Approved (built): a hook cannot call a tool that runs or starts a program, also through other tools. AGENTS.talk does not load. Why: commands in a hook run no hooks, so no `before run` hook would see the program.
- A hook cannot change the step. A hook cannot change the result.

## Open questions

- Done: a hook can `ask` the human.
- Done: `fetch` steps.
