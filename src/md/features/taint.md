# Taint

Values carry labels that say where they came from. The runtime moves the labels through operations, and the audit records them.

Built: the labels, the sources, how labels move, the checks, `untrusted tool`, hook `labels`, the audit notes, the questions at the sinks, and file labels in `.talk/taint.json`.
Docs: a section in docs/docs.md (prose to come), `help untrusted`, `help recipes`, and a rule in the MCP tool description.

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
- Approved (built): taint questions and their answers are recorded as `ask` steps.

## Sinks

- Approved (built): `private` in a fetch URL, headers or body: ask once for each host in a session: `Send private data to api.github.com?` The host keeps the hosts for the session (`privateHosts`). The question comes after the `before fetch` hooks, so a hook can refuse first.
- Approved (built): `untrusted` in a `run` or `start` argument: ask each time: `Run npm with untrusted text from https://...: install left-pad?` The question shows all the arguments, cut at 120 characters, with secrets as `<secret NAME>`.
- Approved (built): `untrusted` in a git commit message or branch name: ask each time: `Commit with untrusted text from ...: <message>?`, `Use a branch name with untrusted text from ...: <name>?`
- Approved: `untrusted` written to a file: allowed; the file remembers the label. In a tool argument: allowed; the checks apply inside the tool.
- Approved (built): no answer, or no, is an error: `The human did not approve untrusted text from https://... here.` The questions and answers are `ask` steps in the audit.
- Later, if the questions get noisy: an AGENTS.talk line to skip the question for a host.

## Files

- Approved (built): a written file remembers its untrusted labels. Reading it gives `private` plus those labels. A full `write` takes the labels of its text only; `append` keeps the file's labels too; `replace` and line edits read the file first, so they keep its labels.
- Approved (built): file labels persist in `@/.talk/taint.json` (scripts cannot change `@/.talk/`). It holds only files with a label beyond `private`: in practice, files written with `untrusted` text. A rewrite with no `untrusted` text removes the entry.
- Approved (built): each entry has the path, a SHA-256 hash of the file's text, the labels with origins, the time, the session and the script number. If the text changed outside ClankTalk, the hash does not match, and the entry is dropped on the next read. `delete` removes the entry; `move` and `git move` move it; `undo` removes it if the text it puts back does not match.
- Approved (built): the audit records each change as a `taint` step: `taint  notes.md  untrusted from https://...`, `cleared`, `moved from old.md`, or `dropped: changed outside ClankTalk`.
- Approved: `.talk/taint.json` goes in `.gitignore`, with all of `.talk/`. Why: it is audit-like data about one machine's work. Checked in, it changes with every untrusted write, it holds paths and sessions of scratch files, and it can describe files in a state that was never committed. Entries are sorted by path anyway.
- Later, maybe: an AGENTS.talk line to share labels in git, with entries only for files that git tracks.

## Limits

- The agent: printed text goes into the agent's context, and the agent can type it back with no label. Taint protects values the agent never sees, `$` globals, and flows inside one script or tool. Teach: plan first, and do not print raw data.
- Control flow is not tracked.
- Programs: taint cannot see inside a program. A tool that brings in web text without `untrusted tool` gives text with only `private`. A program that writes web text to a file is not tracked.
- A file changed outside ClankTalk drops its entry. This is correct for a human edit, but a program can do it too.
- Labels are per value, not per item: a list made from one private item and one typed item is private as a whole.
- At most 5 origins for each label.
