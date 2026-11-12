# Background processes

Approved. A tool can start a program that keeps running, such as a dev server. Scripts can look at it, and stop it.

## Syntax

- Approved: `start <program> [with <arg>, ...] as <name>`, only in a tool, as `run` is. The program and arguments work as in `run`.
- Approved: `process <name>` is a value with `name`, `status` (`running`, `exited` or `stopped`), `code` (the exit code, or null) and `output` (what it printed so far). Use `of`: `the output of process 'site'`. (`process 'site''s output` does not parse, because `'s` after a closing quote starts a string.)
- Approved: `stop process <name>` stops it. Scripts can stop a process, not only tools. `stop` alone is still only for `on error`.
- Approved: `the processes` is the list of processes, newest first. `print` shows one line each: `site: running`.
- Approved: `wait <duration>` and `wait until <condition> [within <duration>]`, from hyperscript. See below.

## Rules

- Approved (built): the host keeps the processes for the session. When the session ends, it stops them all, so nothing is left running.
- Approved (built): a process gets the same environment as `run`: only what `allow env` lists. It runs in the current folder, with no shell.
- Approved (built): at most 5 processes at a time. A name that is still running cannot start again: stop it first.
- Approved (built): the output keeps the last 64 KB.
- Approved (built): on macOS and Linux, a process starts in its own process group, and stop ends the whole group, so `npm run x` does not leave its child running.
- Approved (built): hooks `before start` (`program`, `args`, `name`) and `before stop` (`name`).
- Limit: the OS sandbox for `run` (later) applies to `start` too.

## Wait

- Approved (built): `wait 2 seconds` waits. One step.
- Approved (built): `wait until <condition> within <duration>` checks the condition again every 200 ms. Each check is one step. An error in the condition counts as false, so `wait until (fetch ...)'s status is 200` works while a server starts. At the time limit, it is an error with the last error message. With no `within`, the limit is 30 seconds.
- Approved (built): `fetch` is also a value, as `read` is, so `set page to fetch url` works too. In a condition, use `of`: `the status of fetch url as response`. Changed 2026-11-12: before, this record said to use parentheses: `(fetch url as response)'s status`.
