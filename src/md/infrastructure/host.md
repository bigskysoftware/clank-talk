# Host

The runtime has a general host API. A pi extension is the first host.

- Host API: TODO
- pi extension: TODO
- Other hosts: TODO

## MCP host

Code: `src/js/mcp.js`, started by `bin/clank-talk-mcp.js [--root <dir>]`.

Approved:

- The protocol is hand-written: JSON-RPC 2.0 over stdio, one JSON message per line. No dependency. It answers `initialize`, `ping`, `tools/list` and `tools/call`. Notifications get no answer.
- `initialize` answers with the protocol version that the client asks for.
- One tool, `clank_talk`, with input `{ script }`. It gives back text: the output lines, then the errors (`file line:column message`), then the changed files. A script that does not finish with status `done` sets `isError`.
- Approved: each error shows its source line, with a `^` under the column. For an error in a `.talk` file, the server reads that file from the root to show the line.
- Approved: warnings come in a `--- warnings ---` section, before the errors, in the same form, with the arrow. Warnings do not set `isError`.
- The root is the folder where the server starts, or `--root`.
- One `globals` object for the life of the server, so `$` variables stay between calls.
- One `seen` Map for the life of the server, so the stale-write check works across calls.
- The tool description teaches the language: a short syntax summary, then the tools from AGENTS.talk with their parameters. It is read at `tools/list`, so a change to AGENTS.talk shows when the client lists tools again.
- Approved: the tool description tells the agent: if a change is refused because of AGENTS.talk, tell the human the line to add, and do not try another way to make the change.
- Logs go to stderr. stdout is only for protocol messages.
- Proposed: progress. When a `tools/call` has `_meta.progressToken`, a timer sends `notifications/progress` every 500 ms while the script runs, also while a tool runs. There is no `total`, because the step budget says nothing about how long a script takes. `progress` counts the notifications, because each one must have a larger value. `message` is the current line, command, step and time: `line 3: run (step 3, 0.4s)`. In a tool, the line is in AGENTS.talk. Claude Code showed a percentage with the first version, which used `total`. With no `total`, Claude Code shows the message in small text, such as `(step 3, 2s)`, and no percentage. Later: a better UI, for example a Claude Code panel.
- `--log <file>` appends a readable log of each run: a header with the time, status and steps, the script as written, then the same text the agent gets. The host writes it, so the sandbox does not apply. Humans watch it with `tail -f`. This is the start of the audit feature.

## Dogfood

This repo has an `AGENTS.talk` (`run_tests`, `git_status`, `git_diff`, `git_log`) and a `.mcp.json` that starts the MCP host. There is no `git_commit` tool: commits stay with the human.

- Hard start, ClankTalk only: `claude --tools "" --strict-mcp-config --mcp-config .mcp.json`
- Soft start, all edits through ClankTalk: `claude --disallowedTools Edit Write NotebookEdit`
- `.mcp.json` runs `node bin/clank-talk-mcp.js` from the folder where Claude Code starts. Start Claude Code in the repo root.

## Claude Code

Claude Code can limit the model to clank-talk tools only.
The source is the docs at https://code.claude.com, read 2026-11-09. Verify each item in the current build.

### Mechanisms

- settings.json `permissions.deny`: a bare tool name (`"Bash"`) removes the tool from context. An allow rule cannot override a deny rule.
- `--tools ""`: disables all built-in tools. MCP tools stay.
- `--disallowedTools "Bash" ...`: removes the named tools.
- `--allowedTools`: auto-approves only. It does not restrict.
- `--strict-mcp-config --mcp-config <file>`: loads only the named MCP servers.
- `--permission-mode dontAsk`: denies all calls that are not pre-approved, with no prompt.
- `--restricted` (v2.1.248+): removes command, code and WebFetch tools.
- PreToolUse hooks: exit 2, or `"permissionDecision": "deny"`, blocks a call. A hook cannot allow a call that a deny rule refuses.
- Subagent frontmatter: `tools` is an allowlist, `disallowedTools` is a denylist.
- Agent SDK: `disallowedTools`, `permissionMode`, `hooks`, `mcpServers`, `settingSources: []`.
- Agent SDK (TypeScript): `toolAliases`, for example `{ Bash: 'mcp__workspace__bash' }`, sends built-in calls to an MCP tool.

### Example

```
claude --tools "" --strict-mcp-config --mcp-config clanktalk.json
```

```json
{
  "permissions": {
    "deny": ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch"],
    "allow": ["mcp__clanktalk__*"]
  }
}
```

### Subtleties

- Claude Code enforces these rules, not the OS. They do not limit subprocesses.
- The clank-talk MCP server runs with user rights, outside these rules. The clank-talk runtime must do its own isolation. See [../features/sandbox.md](../features/sandbox.md).
- `EndConversation` stays while an MCP server is loaded.

### Not verified

- SDK `tools: []` behavior.
- `toolAliases` in the Python SDK.
- If `--tools ""` also limits subagents.
- If `--strict-mcp-config` excludes claude.ai connectors.
- OS-level sandbox: https://code.claude.com/docs/en/sandboxing.md (not read).
