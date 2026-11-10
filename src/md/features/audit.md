# Audit

Approved. Code: the "audit" section of `src/js/runtime.js`.

The runtime records every step that touches the world outside the script, so a human can see what the agent did.

## What is recorded

- Approved: one record for each step that touches the world:
  - file reads (once for each file in a script) and file changes, with "undo saved"
  - `run`, `start`, `stop`: the program, its arguments, the sandbox, the exit code and the time it took
  - `git`: the operation
  - `fetch`: the method, the URL, the status and the size
  - `ask`: the question and the answer
  - tool calls: the name
- Approved: `print` and `set` are not recorded: they do not touch the world.
- Approved: never the content of files, only paths and counts. Undo holds the text.
- Approved: each record says where it ran: the script, a tool (by name), or a hook.

## Where

- Approved: one file for each day, in `talk/audit/`: `talk/audit/2026-11-09.log`. Scripts cannot change `@/talk/`, and the sandbox cannot write it, so the agent cannot change its own audit. Only the runtime writes it.
- Approved: the audit is always on.
- Note: add `talk/audit/` to `.gitignore`.

## Formats

- Approved: the default is text, for humans. One block for each script: a header with the time, the script number, the status and the steps; the script as written; then one line for each step: time, kind, target, details, with padded columns. Long values are cut with `...`. Errors come last.
- Approved: `audit as json` in AGENTS.talk writes JSON Lines (`.jsonl`) instead: one line for each step, and one line for each script.

```
== 10:42:01  script 12  done  14 steps ==
in @/src/config.js
  replace 'retries: 3' with 'retries: 5'
run_tests
--
10:42:01  replace  src/config.js         undo saved
10:42:01  tool     run_tests
10:42:09  run      npm test              in a sandbox with local network, code 1, 8.2 s
```

## In scripts

- Approved: `the audit` is the list of this session's records, newest last: `time`, `script`, `kind`, `target`, `details`, `from`. An agent can sum up what it did.
- Approved (built): the host keeps the session (`options.audit`: the script count and the records). The file is written only for a host session, and the MCP host always passes one, so the audit is always on in real use. The runtime library alone, and tests, write no file.
- Approved (built): a read is recorded once for each file in a script. If the audit file cannot be written, the script still runs, and gets a warning.
