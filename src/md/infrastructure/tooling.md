# Tooling

## Decisions

- Language: plain JavaScript, ES modules. No build step, like hyperscript.
- Types: JSDoc comments. A type check with `tsc --checkJs` is optional and can come later.
- Tests: Node's built-in `node:test` and `node:assert/strict`. No test dependency.
- The runtime has no runtime dependencies. This keeps the sandbox small and easy to audit.

## Layout

- `src/md/`: intent and decisions (https://srcmd.org).
- `src/js/`: runtime code. `src/js/clank-talk.js` is the entry point. `src/js/help.js` is the help table.
- `bin/clank-talk-mcp.js`: starts the MCP host.
- `test/*.test.js`: tests. Run with `npm test`.
