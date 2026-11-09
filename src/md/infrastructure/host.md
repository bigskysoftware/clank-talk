# Host

The runtime has a general host API. A pi extension is the first host.

- Host API: TODO
- pi extension: TODO
- Other hosts: TODO

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
