# Feature backlog

Ideas that are not approved yet. When a human approves one, it moves to the record of its feature, as Proposed or Approved. Built items leave this file.

## Plugins

A plugin adds tools, syntax, or both, so a team can share what it built. See `features/plugins.md` (a stub) and `features/agents-talk.md` (Import).

- **What is decided:** the user imports plugins, and the agent cannot. Plugins are `.talk` files only. `talk/` is the suggested folder for them, and scripts cannot change it.
- **Share a set of tools:** a plugin is a `.talk` file with tools and hooks, for example `talk/github.talk` with `gh` tools marked `untrusted tool`. A user imports it with `import ./talk/github.talk`. Open: how a plugin is found and installed (a git URL, npm, a copy), and how its version is pinned.
- **Declare behavior:** a plugin says how its steps behave for the audit, taint and undo. For example: a tool's result is untrusted, a tool changes files and undo can take them back, or a tool cannot be undone.
- **New syntax from a plugin:** a plugin adds a command or an expression to the language. This needs a plugin API in the parser and the runtime. Open: the API, and how `help` lists plugin syntax.
- **JavaScript plugins:** `.js` plugins run with the user's full rights, so they are refused today. Open: allow them only from `talk/`, only when AGENTS.talk names them, and only in a worker with no file or network access.
- **Policy:** a harness policy can allow or deny plugins by name.

## Language

- **Numbered replace.** The old text of a `replace` names its line numbers, in the form that `print` shows:

  ```talk
  replace
  33: | total = price * qty
  34: | return total
  with
  | total = price * qty * (1 - off)
  | return total
  in @/src/cart.js
  ```

  - The reader sees where the edit goes, and the old and new text, like a small diff.
  - The runtime checks that those lines hold exactly that text, or the edit fails with the text that is there now. A plain `replace` changes every match.
  - The agent can copy the lines from `print lines 30 to 40 of f`.
  - Limits: whole lines only; it needs fresh line numbers (read first; edits below shift); the numbers must run in order; one file only.
  - Open: `33: | text` (the print format) or `33 | text`; also for `remove`.
  - Related, no syntax: the audit notes the lines that each `replace` changed (`lines 33-34`).
- **Pattern flags.** A way to match without letter case. `(?i)` is not JavaScript syntax.
- **Find without letter case**, for plain text too.
- **`for line in <file>`:** a loop over the lines of a file, with no `lines of`.
- **Git commands give values,** for example `git status` as a list of changed files, not only text.
- **Clearer errors:** `print exists @/x` says "Expected a command" (write `@/x exists`); `print git branch` suggests `the git` (run `git branch`, then `print it`).
- **A missing property is null with no warning** (`t.replaceAll`). A warning for a property that a string or a list does not have.
- **The error model and data types:** open questions in `features/language.md`.
- **A quoted path is never a glob.** `./"*.txt"` is a glob today, so a script cannot name a file with `*`, `?`, `[` or `{` in its name. Found in the testing pass (2026-11-10).
- **A write with no final line break.** A warning when `write` makes a file that has no line break at the end (a `|` block has none). Declined for now (2026-11-10).

## Runtime and hosts

- **Progress for long scripts.** MCP progress notifications with the current line, step and time. Proposed in `infrastructure/host.md`.
- **Pause and resume a run:** `execution.running`, `pause()` and `resume()`, so the agent can look at a program's output so far.
- **A memory limit** for scripts. An in-process runtime cannot enforce one well. See `features/sandbox.md`.
- **pi:** custom rendering of ClankTalk results, and pi commands.
- **Two agents, one file:** a lock, or a clear error, when two agents change the same file at the same time.

## Subagents

- **Claude Code agent files.** Generate `.claude/agents/<tool>.md` from tools with `in a subagent`, with a ClankTalk server limited to the `with only` tools, so the harness runs them as its own background agents, with its interface and its billing.
- **Other harness adapters,** such as `codex exec` or `gemini`, for teams that want their own harness and login in place of an API key.
- **A model for one tool:** `in a subagent with only gh_issues, model 'claude-haiku-5-5'`.
- **Refusal fallbacks** for the Anthropic API.
- **A real run:** test once with pi's model and once with an API key. Only fakes have tested it.

## Taint

- **Session taint, part (b):** the `npx clank-talk taint` command line. See [taint.md](features/taint.md).
- **Session taint, part (c):** the judge.
- **A human-only MCP tool:** `taint_approve` with `requiresUserInteraction`, for Claude Code, after a test.

## Safety

- **A fetch judge.** Ask a classifier model if an outbound fetch sends project data out. In pi: `ctx.modelRegistry.classify()` (for example Jev). It needs a structured summary of the request, not raw text, and "no" when the judge fails.
- **A secret in a fetch URL,** with redaction in the audit, hooks and errors. Today it is an error.
- **Typed parameters** for tools, such as `tool lint with file as path`. The runtime checks the value before `run`. See `infrastructure/security.md`.
- **The OS keychain** as a source of secrets.
- **The Linux sandbox below the project root.** `bwrap` protects hidden and `.talk` files only at the top level, and only the files that exist when the program starts. Thus a sandboxed program can change an imported `subdir/tool.talk`, or make a new hidden file. Options: fail closed when the sandbox can write the project; a mode with a read-only project and named output folders (`writes to './build'`); or Landlock. See `features/sandbox-run.md`.
- **DNS rebinding in fetch.** Connect only to an address that the check saw, and keep the name for TLS. See `features/fetch.md`.

## Docs

- **Your prose:** the `TODO (Carson)` sections in `docs/docs.md`, and a note on `|` text blocks there.
- **The README hero image** must be taken again when the first bubble example changes.
