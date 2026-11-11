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
- Approved (built): each record has the `agent` name that sent the script, or null. The text header shows it: `script 12 (agent tester)`, or `script 12 (main)` with no name. `(main)` means no name was given: the main agent, or a subagent that did not pass its name. Claude Code sends no caller id, so ClankTalk cannot tell them apart.
- Approved (built): the header names the host session: `session claude-code-4f2a`, from the MCP client's name (`clientInfo.name`) and 4 random characters; `pi-...` in pi. The JSON format has a `session` field. Why: two sessions on one day write to the same file, and each counts its scripts from 1.

## Where

- Approved (built): one file for each day, in `.talk/audit/`: `.talk/audit/2026-11-09.log`. Scripts cannot change `@/.talk/`, and the sandbox cannot write it, so the agent cannot change its own audit. Only the runtime writes it.
- Approved: the audit is always on.
- Approved (built): we recommend `.talk/` in `.gitignore`: the audit is a log, not source. The README and the docs say so, and this repo does it.
- Approved (built): two folders. `talk/` is the suggested folder for extensions: shared `.talk` tool files that AGENTS.talk imports. It is visible, because people review it. `.talk/` holds internals: the audit (`.talk/audit/`) and the untrusted inputs (`.talk/untrusted/`). It is hidden, because people rarely open it. Scripts cannot change either folder.
- Approved (built): no `allow changes to` line can open `.talk/` or `talk/`: it is a load error. Globs skip `.talk/`, as they skip `.git/`.
- Approved (built): rotation. The host keeps 3 days of audit files by default. `keep audit for 7 days` in AGENTS.talk keeps more or fewer. Once a day, when it writes the first block, the host deletes day files older than that: only names such as `2026-11-10.log` and `2026-11-10.jsonl`. The audit notes it: `audit  .talk/audit/  deleted 2 files older than 3 days`.
- Approved (built): a policy sets the fewest days: `keep audit for at least 30 days`. An AGENTS.talk line with fewer days is a load error. With no AGENTS.talk line, the host keeps the larger of 3 days and the policy's days. The policy's `audit also to` copy is never rotated.
- Risk: with the default of 3 days, the audit of a problem from last week is gone. Teams can keep more, or set a policy.

## Formats

- Approved: the default is text, for humans. One block for each script: a header with the time, the script number, the status and the steps; the script as written; then one line for each step: time, kind, target, details, with padded columns. Long values are cut with `...`. Errors come last.
- Approved (built): the script is indented by 2 spaces, and a line break or other control character in a value shows as `\n`, `\t` or `\u001b`. Thus only the audit itself writes a line that starts with `==` or is `--`, and a script cannot fake a header or a step.
- Approved: `audit as json` in AGENTS.talk writes JSON Lines (`.jsonl`) instead: one line for each step, and one line for each script.

```
== 10:42:01  session claude-code-4f2a  script 12 (main)  done  14 steps ==
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
