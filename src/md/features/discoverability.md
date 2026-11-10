# Discoverability

An agent must be able to learn the language from the runtime itself.

## Requirements

- A top-level mechanism lists all syntax in the language: commands, expressions, features and plugin syntax.
- An agent can introspect each piece of syntax. The result includes a description and examples.
- Plugins and AGENTS.talk tools must give the same information, so they are discoverable too.

## Decisions

Approved:

- The words after `help` must be on the same line as `help`. This is an exception to "a line end does not end a command", so that `help` alone can be followed by other commands. `then` ends the words, except as the first word.
- `help` prints its text, and also puts it in the result.
- An unknown word is an error that tells the agent to use `help`.
- The help text lives in `src/js/help.js`, as a table with one entry for each command and each kind of expression. A test parses every example, so the examples stay correct.
- The MCP tool description lists each tool with the first line of its comment, and tells the agent about `help`.
- `help` lists all commands, expressions and tools. `help <word>` shows one, with its syntax, a description and examples. Approved (built): if more words have no entry, such as `help git commit`, help shows the entry for the first word. `help commands`, `help expressions` and `help tools` show one group.
- The `#` comment lines just above a `tool` in AGENTS.talk are its description.

## Open questions

- A test that every command word has a help entry. The command table is inside the parser now.
- Done: the MCP tool description comes from the same table. See below.
- Done: the docs are in two: docs for humans (`docs/docs.md`) and docs for agents (the Reference page, from the help table).

## One source for agent docs

- Approved: the help table in `src/js/help.js` is the one source for agent docs. It makes three things:
  - `help` and `help <word>` in scripts
  - the Reference page on the site (`referenceMarkdown()`, built by `docs/build.js` into `_site/reference.html`; not in git)
  - the syntax summary in the MCP tool description (`syntaxSummary()`: the syntax and the first sentence of each entry)
- Approved: the MCP tool description also has a short hand-written part: what ClankTalk is, strings and access in one paragraph, and the rules for the agent (refused changes, line edits, ask, sandbox).
- Approved: the human docs (`docs/docs.md`) tell the story, and link to the Reference for the exact syntax.
- Thus: put the most important rule of each entry in its first sentence, because the tool description shows only that.
## Recipes

- Approved: `help recipes` shows common tasks done well: look before you edit, change and test and undo, read only the failures, find then rename, ask before something big, start a server and wait, commit your work, catch up and test before a merge. They teach habits, not syntax. They live in `RECIPES` in `src/js/help.js`, show in the docs for agents, and every recipe must parse (test/help.test.js). The MCP rules name `help recipes` in one line. No new grammar: `help <word>` already exists, like `help tools`.
