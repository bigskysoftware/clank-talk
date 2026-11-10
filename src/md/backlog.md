# Feature backlog

Ideas that are not approved yet. When a human approves one, it moves to the record of its feature, as Proposed or Approved.

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
- **Pattern flags.** A way to match without letter case; `(?i)` is not JavaScript syntax.
- **A write with no final line break.** A warning when `write` makes a file that has no line break at the end (a `|` block has none). Declined for now (2026-11-10).

## Audit

- Built: audit rotation, and `.talk/` for internals. See `features/audit.md`.

## Subagents

- **Claude Code agent files.** Generate `.claude/agents/<tool>.md` from tools with `in a subagent`, with a ClankTalk server limited to the `with only` tools, so the harness runs them as its own background agents, with its interface and its billing.
- **A model for one tool:** `in a subagent with only gh_issues, model 'claude-haiku-5-5'`.
- **Refusal fallbacks** for the Anthropic API.

## Safety

- **A fetch judge.** Ask a classifier model if an outbound fetch sends project data out. In pi: `ctx.modelRegistry.classify()` (for example Jev). Needs a structured summary of the request, not raw text, and a "no" when the judge fails.
- **`run` arguments that start with `-`.** Refuse them, or typed parameters. See `infrastructure/security.md`.
- **Programs found through `PATH`.** Resolve each program to a full path when AGENTS.talk loads, and warn if it is inside the project.
- **Share taint labels in git.** An AGENTS.talk line that keeps `.talk/taint.json` in git, with entries only for files that git tracks.

## Plugins

- **The plugin API**, and how a plugin declares its audit, taint and undo behavior. See `features/plugins.md`.

