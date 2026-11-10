# Taint

Values carry labels that say where they came from. The runtime moves the labels through operations, and the audit records them.

Built (branch 1, taint-core): the labels, the sources, how labels move, the checks, `untrusted tool`, hook `labels`, and the audit notes.
Not built yet: the questions at the sinks (branch 2), file labels and `talk/taint.json` (branch 3), the docs (branch 4).

Code: `src/js/taint.js`, with small hooks in `src/js/runtime.js`.

## Goal

- Approved: two threats, two labels. A value can have both.
  - A. Data goes out (exfiltration). Label `private`. Sink: fetch (URL, headers, body).
  - B. Untrusted text goes in (prompt injection). Label `untrusted`. Sinks: `run` and `start` arguments, git commit messages and branch names.
- Not a goal: what a program does inside itself. Taint tracks values only inside ClankTalk.

## Sources

- Approved (built): `private`: `read`, file properties (`text`, `lines`), `find` in files, `git` output, `run` output, process output, `the previous output`, `the audit`.
- Approved (built): `untrusted`: fetch responses (text, JSON values, headers), with the URL as its origin.
- Approved (built): `untrusted tool <name> ... end` in AGENTS.talk: the tool's result is `untrusted`, with the origin `tool <name>`. Without it, `run` and `start` output is only `private`, also with the network: the tool author decides. Mark any tool that brings in text from the network (`curl`, `gh`, `npm view`).
- Approved (built): no label: `ask` answers (from the human), text that the script types, file paths themselves.

## How labels move

- Approved (built): labels go on expressions, not on each value. Each expression collects the labels of what it reads, and gives them to the expression around it. Thus a value made from labeled values has all their labels: `+`, `${}`, `replace` in text, `lines of`, `first`, `last`, indexes, properties, conversions, `sorted`, `unique`, `find` in text, `length`, and check results.
- Approved (built): variables, `$` globals, `the result`, tool arguments and tool results keep one set of labels next to the value. A list or object keeps one set for all its items, wherever it goes. Why: values stay plain JavaScript, so the runtime does not change; the cost is extra labels, never fewer.
- Approved (built): each command has its own frame, so control flow gives no labels: `if page contains 'x'` does not label what the `if` body sets.
- Approved (built): an untrusted label keeps at most 5 origins.

## Checks and hooks

- Approved (built): `<value> is untrusted`, `is not untrusted`, `is private`, `is not private`. They check the labels, not the value.
- Approved (built): each hook step has `labels`, a list such as `[{ label: 'untrusted', from: ['https://example.com/notes'] }, { label: 'private', from: [] }]`: the labels of what the command read before the hook. The step's fields carry the same labels.
- Approved: no way to remove a label in scripts, tools or hooks. Print does not show labels. No script form for origins in the first version.

## Audit

- Approved (built): a step notes the labels of what its command read: `run  echo ...  code 0, 0.1 s  (untrusted from https://example.com/notes)`. A fetch line notes `untrusted` with its URL. A call to an untrusted tool notes `untrusted from tool issue`.
- Approved (built): all file text is private, so a read or a file change notes only `untrusted`. Why: `(private)` on every file change is noise.
- Approved (built): JSON audit records have a `labels` field.
- Approved: taint questions and their answers are recorded as `ask` steps (branch 2). `taint.json` changes and hash drops are recorded (branch 3).

## Sinks (branch 2)

- Approved: `private` in a fetch URL, headers or body: ask once for each host in a session: `Send private data to api.github.com?`
- Approved: `untrusted` in a `run` or `start` argument: ask each time: `Run npm with untrusted text from https://...: <argument>?`
- Approved: `untrusted` in a git commit message or branch name: ask each time.
- Approved: `untrusted` written to a file: allowed; the file remembers the label. In a tool argument: allowed; the checks apply inside the tool.
- Approved: no answer, or no, is an error.
- Later, if the questions get noisy: an AGENTS.talk line to skip the question for a host.

## Files (branch 3)

- Approved: a written file remembers its labels. Reading it gives `private` plus those labels.
- Approved: file labels persist in `@/talk/taint.json` (scripts cannot change `@/talk/`). It holds only files with a label beyond `private`: in practice, files written with `untrusted` text. A rewrite with no `untrusted` text removes the entry.
- Approved: each entry has the path, a hash of the file's text, the labels with origins, the time, the session and the script number. If the text changed outside ClankTalk, the hash does not match and the entry is ignored. Delete and move update entries.

## Limits

- The agent: printed text goes into the agent's context, and the agent can type it back with no label. Taint protects values the agent never sees, `$` globals, and flows inside one script or tool. Teach: plan first, and do not print raw data.
- Control flow is not tracked.
- Programs: taint cannot see inside a program. A tool that brings in web text without `untrusted tool` gives text with only `private`. A program that writes web text to a file is not tracked.
- A file changed outside ClankTalk drops its entry. This is correct for a human edit, but a program can do it too.
- Labels are per value, not per item: a list made from one private item and one typed item is private as a whole.
- At most 5 origins for each label.
