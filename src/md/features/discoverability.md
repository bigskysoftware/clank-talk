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
- `help` lists all commands, expressions and tools. `help <word>` shows one, with its syntax, a description and examples. `help commands`, `help expressions` and `help tools` show one group.
- The `#` comment lines just above a `tool` in AGENTS.talk are its description.

## Open questions

- A test that every command word has a help entry. The command table is inside the parser now.
- Generate the MCP tool description from the same table.
- TODO: split the docs in two. Docs for humans (docs/, in the hyperscript tone) and docs for agents (help, the MCP description: short, exact, every rule). Now docs/docs.md tries to do both.
