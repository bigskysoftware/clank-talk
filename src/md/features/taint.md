# Taint

Values carry labels that say where they came from. The runtime moves the labels through operations, and the audit records them.

Built: session taint, part (a): the flag, the store, the questions, `taint on|off|required`, `keep untrusted inputs up to`, `require taint` in a policy, and the session checks for hooks. The value labels below are removed.
Built: part (b), the command line: `bin/clank-talk.js`, `src/js/taint-cli.js`.
Built: part (c), the judge: `src/js/judge.js`.
Docs: a section in docs/docs.md (prose to come), `help untrusted`, `help recipes`, and a rule in the MCP tool description.

Code: `src/js/untrusted.js`, with small calls in `src/js/runtime.js`.

## Session taint

Replaces the labels on values below. Why: labels follow values inside one script, but an injection goes through the model's context, and the agent can type the text back with no label. The labels cost about 280 lines, 81 calls in the runtime, and a check in each new feature. A flag on the session matches the real threat, and it is much smaller.

### The flag

- Approved (built): after the agent sees untrusted text, the session is untrusted. Sources: fetch, an `untrusted tool`, a subagent (its answer, also from `process` and `stop`).
- Approved (built): the session stays untrusted while at least one of its untrusted inputs is not approved.
- Approved (built): the flag comes from the store on disk, so it holds across scripts and host restarts. A run with no session name uses the folder `default`.
- Approved (built): if the store cannot be written, the step fails. Why: an input that is not saved cannot make the session untrusted.

### On and off

- Approved (built): AGENTS.talk sets the default: `taint on` (the default with no line), `taint off`, or `taint required`.
- Approved (built in the runtime; the command is part (b)): the command line can change it: `npx clank-talk taint on`, `npx clank-talk taint off`. This choice wins over `taint on` and `taint off` in AGENTS.talk. It is kept in `.talk/taint-state.json`, which scripts cannot change.
- Approved: `taint required` keeps it on. `taint off` on the command line then fails: "AGENTS.talk has 'taint required'. To turn taint off, remove that line." (Built in the runtime: the state file is ignored.)
- Approved (built): a policy can hold `require taint`, with the same effect as `taint required`.
- Approved: `npx clank-talk taint` shows the state and where it comes from: "on (from AGENTS.talk)", "off (from the command line)".

### Which actions ask

- Approved (built): while the session is untrusted, these ask the human: push, `run` or `start` with network, a fetch to a new host, a fetch with a secret, a commit.
- Approved (built): a `run` or `start` with no sandbox asks too, because it has the network. `with local network` does not ask.
- Approved (built): a sandboxed `run` or `start` with no network does not ask. File edits do not ask.
- Approved (built): the question names the inputs that are not approved, at most 5: "Push origin? 2 untrusted inputs are not approved: tool issue (42), https://... Review them with: npx clank-talk taint".
- Approved (built): the answers: `approve them and go on` (approves only the inputs that the question named), `yes, this time only` (the session stays untrusted), `no`. No answer is no.
- Approved: a host in `allow fetch from` stays trusted in an untrusted session: a GET, a POST or a body to it asks nothing. Why: the human chose these hosts. Rejected: a question for a body or a method other than GET.
- Approved (built): a fetch to a new host in an untrusted session asks one question, the session question. A yes (either form) also allows the host for the session, as the host question does.
- Approved (built): a `run` or `start` with no sandbox asks too.

### The store

- Approved (built): each untrusted input is saved in `@/.talk/untrusted/<session>/`: `index.json` (number, time, source, size, cut, approved), and `<n>.txt` with the source, the time, and the text. Secrets show as `<secret NAME>`. Scripts cannot change `.talk/`.
- Approved (built): the source: the final URL after redirects for a fetch; the name and arguments for a tool; the tool and prompt for a subagent.
- Approved (built): at most 1 MB for each input by default. A larger input keeps its first 1 MB, and gives a warning in the script output: "warning: untrusted input 3 is 5 MB; the store kept the first 1 MB". The list (part b) shows it too.
- Approved (built): `keep untrusted inputs up to 5 MB` (or `KB`) in AGENTS.talk sets the size.
- Approved (built): the `keep audit` rules apply to the store. Once a day, with the audit rotation, a session whose newest input is older than the kept days is deleted, and the audit notes it. A broken store is kept for the human. The cleanup runs only when the audit is written to `.talk/audit/`.
- Approved (built): the audit records each input (`untrusted`, with the file), and each approval (`approve`, with the input numbers).

### The command line

- Approved (built): a new `clank-talk` command, next to `clank-talk-mcp`. Only the human runs it: the agent has no shell in ClankTalk. It takes `--root`, and else `CLANK_TALK_ROOT` or the current folder, as the MCP server does.
- Approved (built): `npx clank-talk taint` shows the state and where it comes from, and lists all inputs: ref, time, status, size, judge verdict, source.
- Approved (built): a ref is `<session>/<n>`, such as `claude-code-4f2a/3`. A bare `<n>` is in the newest session.
- Approved (built): `taint show <ref>`, `taint approve <ref> ...`, `taint approve --all` (clears all taints), `taint approve --clean`, `taint on`, `taint off`. A bad ref approves nothing. An approval records who approved (`the question` or `the command line`) and when.
- Approved (built): `taint judge <ref> ...` reads those inputs again; `taint judge --all` reads the inputs that have no verdict and are not approved.
- Limits, to document: the boundary holds only if the agent has no other shell (turn off the harness tools), each `run` is sandboxed (a program with no sandbox can change `.talk/`), and no tool in AGENTS.talk runs `clank-talk taint`.

### The judge

- Approved (built): a model call with no tools reads one input, and gives `clean`, `suspect` or `unsure`, with a reason of at most 200 characters. The verdict is saved in the index, next to the input.
- Approved (built): the answer is one line of JSON: `{"verdict": ..., "reason": ...}`. An answer that is not valid, a refusal or a cut answer is `suspect`, so a broken answer cannot approve.
- Approved (built): the text goes between markers with a random name, so the text cannot close the block. The source goes before it.
- Approved (built): a fixed default prompt in `src/js/judge.js`. `judge with prompt '...'` (or a text block) in AGENTS.talk replaces it. The answer format is always added after the prompt.
- Approved (built): by default the verdict is advice only. A human approves.
- Approved (built): `let the judge approve clean inputs` in AGENTS.talk: a `clean` verdict approves the input (`approvedBy: the judge`). `suspect` and `unsure` never approve. `require taint` in a policy does not block this line.
- Approved (built): `use model '<id>' for judging [with secret <NAME>]`. With no line, the judge uses the subagent model. pi lends its model. The key needs `allow secret <NAME> for subagents`.
- Approved (built): by default the judge runs only on `npx clank-talk taint judge`. `judge untrusted inputs automatically` in AGENTS.talk runs it on each new input. A judge that fails gives a warning, and the input stays.

### Security review (built)

- A broken `index.json` counts as an input that is not approved, so the session stays untrusted. A new input is not saved over it: the step fails, and a human must repair or remove the file.
- One change at a time to a session's index, so two scripts in one process cannot lose an input.
- The question names at most 5 inputs, and `approve them and go on` approves only those.
- A source in a question, and all untrusted text on the command line, show control characters as `?`. A source in a question is cut at 80 characters.
- The error of an untrusted tool is an untrusted input too, as the agent sees it.
- A session name that starts with dots stays inside the store.
- Before a sandboxed run, `.talk/` is made, because on Linux the sandbox protects a hidden folder only if it exists when the program starts.
- Approved (built), best effort: around a `run` with no sandbox, ClankTalk keeps a hash of each file in `.talk/`, a copy of the taint control files (`taint-state.json`, each `index.json`), and the last 1000 lines of the newest audit file. After the run, if a file changed: the error names each changed file, the control files go back (so taint cannot be turned off or approved this way), the output shows the saved audit lines, the audit notes a `restore` step, an untrusted input names the files, and the step fails. Other files are not put back. Writes of ClankTalk's own during the run (for example a background subagent that writes the audit) are noted, and are not changes; a second server process on the same project can still look like a change.
- Limits, to document: a `start` with no sandbox keeps running, so it is not checked. A run with no sandbox can still change files outside `.talk/`. A policy with `require sandbox for run, start` closes this. Response headers from `fetch ... as response` do not go to the store. The cleanup runs only with the audit file.

### Hooks

- Approved (built): `the session is untrusted` and `the session's untrusted inputs` (source and time) replace the label checks. `is untrusted` and `is private` on values go away. The old form gives a load error that names the new one.

### Open

- Built, to confirm: the `private` label and its question (`Send private data to api.github.com?`) went away with the labels. While the session is trusted, a fetch to a new host still asks (fetch.md).
- Built: `.talk/taint.json` (file labels) went away. An old file stays on disk and is not read.
- Later: a `taint_approve` MCP tool with `_meta["anthropic/requiresUserInteraction"]: true`, for Claude Code, after a test. The Claude Code docs do not say if the model can run MCP prompts, so prompts are not a human-only path.

## Value labels (removed: replaced by session taint)

## Goal

- Approved: two threats, two labels. A value can have both.
  - A. Data goes out (exfiltration). Label `private`. Sink: fetch (URL, headers, body).
  - B. Untrusted text goes in (prompt injection). Label `untrusted`. Sinks: `run` and `start` arguments, git commit messages and branch names.
- Not a goal: what a program does inside itself. Taint tracks values only inside ClankTalk.

## Sources

- Approved (built): `private`: `read`, file properties (`text`, `lines`), `find` in files, `git` output, `run` output, process output, `the previous output`, `the audit`.
- Approved (built): `untrusted`: fetch responses (text, JSON values, headers), with the URL as its origin.
- Approved (built): `the previous output` also has the labels of all that the last script printed. The run result gives them as `outputLabels`, and the host keeps them for each agent, next to the text. Thus web text that a script printed is still untrusted in the next script. The labels cover the whole output, not each line.
- Approved (built): `untrusted tool <name> ... end` in AGENTS.talk: the tool's result is `untrusted`, with the origin `tool <name>`. Without it, `run` and `start` output is only `private`, also with the network: the tool author decides. Mark any tool that brings in text from the network (`curl`, `gh`, `npm view`).
- Approved (built): no label: `ask` answers (from the human), text that the script types, file paths themselves.

## How labels move

- Approved (built): labels go on expressions, not on each value. Each expression collects the labels of what it reads, and gives them to the expression around it. Thus a value made from labeled values has all their labels: `+`, `${}`, `replace` in text, `lines of`, `first`, `last`, indexes, properties, conversions, `sorted`, `unique`, `find` in text, `length`, and check results.
- Approved (built): variables, `$` globals, `the result`, tool arguments and tool results keep one set of labels next to the value. A list or object keeps one set for all its items, wherever it goes. Why: values stay plain JavaScript, so the runtime does not change; the cost is extra labels, never fewer.
- Approved (built): each command has its own frame, so control flow gives no labels: `if page contains 'x'` does not label what the `if` body sets.
- Approved (built): `on error` keeps the labels of the failed command: the error's message can hold its values, so `error` gets the labels of everything that the command read. Why: without it, a script could make a private or untrusted value fail on purpose, and send the message out with no question (security review 2).
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
- Approved (built): each entry has the path, a SHA-256 hash of the file's text, the labels with origins, the time, the session and the script number. If the text changed outside ClankTalk, the hash does not match, and the entry is dropped on the next read. `delete` removes the entry; `move` and `git move` move it.
- Approved (built): undo puts the labels back with the text. Each change keeps a copy of the file's entry from before it; when undo restores text that matches that entry's hash, the entry comes back (for a write, a delete and a move). Why: without it, a write and an undo removed an untrusted label (security review 2).
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
