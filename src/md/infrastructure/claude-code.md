# Claude Code plugin

The `clank-talk` plugin makes Claude Code a better ClankTalk harness: its questions in Claude Code's own question dialog, `/taint`, `/clank-talk`, a guard on other tools, and a record of the allowed ones. The MCP server (`bin/clank-talk-mcp.js`) still runs the scripts; the plugin is the human's side.

Code: `src/js/harnesses/claude-code/` (`.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.tsx`, `types/index.d.ts`). Records of each part: `src/md/features/ask.md`, `taint.md`, `harness-tools.md`.

## Rules

- Approved (built, 2026-11-11): one hooks module in TypeScript, for Claude Code's own plugin runtime, not Node: no imports but `claude-code`, and everything outside goes through `$`. Its folder was `claude-code/` at the root first; it moved to `src/js/harnesses/claude-code/` on 2026-11-11, beside `pi.js`, so all harness code is in one place. The npm package now includes it, because `files` has `src/js/`.
- Approved (built, 2026-11-11): the repo is a marketplace: `.claude-plugin/marketplace.json` at the root lists the plugin with `"source": "./src/js/harnesses/claude-code"`. Install: `/plugin install clank-talk --marketplace bigskysoftware/clank-talk`. For work on the plugin, add the repo folder as a marketplace (`claude plugin marketplace add <folder>`); Claude Code then reads the plugin from the folder, and `/reload-plugins` loads an edit.
- Approved (built, 2026-11-11): the plugin runs the ClankTalk command line for each step (`taint --json`, `show`, `approve`, `clear`, `harness --json`, `harness record`), so the rules stay in one place. In the ClankTalk repo itself it runs `node bin/clank-talk.js`; elsewhere `npx --yes clank-talk`, which takes the project's installed copy first. Limit: these commands need a release after 0.1.2.
- Approved (built, 2026-11-11): the human's side. `/taint` and `/clank-talk on|off` run only from the person's own Enter (`origin.kind` is `composer`). The answer to a question goes to a `127.0.0.1` URL with a one-time token that only the elicitation carries, which the model never sees.
- Approved (built, 2026-11-11): the on/off state is in the plugin's memory, for the session; a reload turns ClankTalk on again in a project with an AGENTS.talk. The plugin writes the state to `.talk/harness/claude-code-<session id>.json` for the status line only.
- How to check a change: `claude plugin validate src/js/harnesses/claude-code`, and `tsc` with the plugin types that Claude Code writes (see the plugin-authoring skill). Both need Bash, which ClankTalk blocks while it is on: run `/clank-talk off` first, or add `allow harness tools Bash`.

## Not yet

- Tests in the plugin's own kit (`claude plugin test`). Today the CLI parts have node tests, and the plugin is checked by hand.
- A cleanup of old files in `.talk/harness/`.