# pi host

Status: first version built. Code: `src/js/harnesses/pi.js` (the entry), `src/js/harnesses/pi-host.js`, and `src/js/host.js` (shared with the MCP server). Plan and research: `tmp/pi-plugin.md`.

## Why

- Over MCP, pi has no elicitation, so `ask` and the fetch approval of a new host always give null (no). Tested in pi 1.5.1 on 2026-11-09.
- Over MCP, the human must start pi with the right flags. The extension locks pi down by itself.

## Rules

- Approved (built): the extension registers one tool, `clank_talk`, with `script` and `agent`. It calls `run()` in pi's process. The description and the result text are the same as the MCP server's (`host.js`).
- Approved (built): on `session_start`, `pi.setActiveTools(["clank_talk"])`. A `tool_call` guard blocks every other tool, also MCP tools and codemode calls.
- Approved (built): `ask` goes to `ctx.ui.select` (with choices) or `ctx.ui.input`. With no UI (`ctx.hasUI` false), there is no ask, so the answer is null. A dialog that gives no text gives null.
- Approved (built): one session for the pi session, as in the MCP server: `$` globals, reads, undo, agents, fetch approvals, processes and the audit. `session_shutdown` stops the background processes.
- Approved (built): `executionMode: "sequential"`, because calls share the session. Esc cancels the script through pi's `signal`. Progress goes to `onUpdate`, at most every 500 ms.
- Approved (built): pi registers the tool before it knows the project, so the first description says `help tools` lists the AGENTS.talk tools. On `session_start`, the extension registers the tool again with the tools from the project's AGENTS.talk, the same text as the MCP server's. A second `registerTool` replaces the first (pi docs, Tool Exposure).
- Approved (built): `--clank-policy <file>` and `--clank-policy-hash <sha256>`, pi flags from `registerFlag`, set a harness policy, as `--policy` and `--policy-hash` do for the MCP server. Pi gives flag values only after loading, so the extension reads them on `session_start`. A wrong hash or a missing file makes every call an error: `ClankTalk does not run: ...`. The policy reading is shared: `readPolicyFile` in `host.js`.
- Approved (built): `package.json` has `"pi": { "extensions": ["./src/js/harnesses/pi.js"] }`, the `pi-package` keyword (for the pi package gallery), and `typebox` as an optional peer dependency with the range `*`: pi supplies it, and its docs say not to bundle it. It is not on npm. Install from git: `pi install -l git:github.com/bigskysoftware/clank-talk`, or try it with `pi -e`. The docs recommend the project install (`-l`): a user install makes every pi session ClankTalk-only.
- `harnesses/pi.js` imports `Type` from `typebox`, which pi maps to its own copy. The tests call `clankTalkExtension(pi, Type)` with a fake pi and a fake Type.
- Proposed (built, 2026-11-11): `/taint`, a pi command, runs `clank-talk taint --tui` over pi. In `ctx.ui.custom`, pi stops its TUI, the review runs as a child process with the terminal (`spawnSync`, `stdio: "inherit"`), and pi starts again. Only the human can type a command, so the model cannot approve through it. With no UI, `/taint` does nothing. Why: the review must stay on the human's side, and one review program serves every harness. Rejected: the review inside pi's own TUI (`ctx.ui.custom` components): a second copy of the TUI.
- Proposed (built, 2026-11-11): the footer shows the same text as the Claude Code status line, with `ctx.ui.setStatus`: `clank-talk: on, untainted`, `clank-talk: off, tainted 3`, or `clank-talk: on, taint off`. Before, it showed `taint: <n> not approved (/taint)`, or nothing. It is updated on `session_start`, after each `clank_talk` call, on `agent_end`, and after `/taint`. Limit: an approval in another terminal shows only at the next of these events.

## Not yet

- No custom rendering, no commands.
- Not verified in a real pi session: the `ctx.ui.input` arguments, and that `isError` in a tool result works as in the docs.

## Limits

- The extension runs in pi's process, with full user rights. Another extension can register tools or get around the guard. Load no other extensions when it matters: `pi --no-extensions -e ./src/js/harnesses/pi.js`.
- A slow, synchronous step blocks pi's screen. The MCP server runs in its own process.
