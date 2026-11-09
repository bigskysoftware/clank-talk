# Discoverability

An agent must be able to learn the language from the runtime itself.

## Requirements

- A top-level mechanism lists all syntax in the language: commands, expressions, features and plugin syntax.
- An agent can introspect each piece of syntax. The result includes a description and examples.
- Plugins and AGENTS.talk tools must give the same information, so they are discoverable too.

## Open questions

- How an agent asks: syntax, host tool, or both: TODO
- Format of the result (text, JSON): TODO
- Where the descriptions and examples live (next to the parser code?): TODO
- Can examples be run as tests, so they stay correct?: TODO
