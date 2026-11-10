# ClankTalk

A sandboxed scripting language for AI agents. You give your agent ClankTalk, in place of a shell.

```applescript
in @/src/config.js
  replace 'retries: 3' with 'retries: 5'

run_tests

if the result's code is not 0
  undo
end
```

It reads like English, because the agent writes the script but *you* have to read it. And there is no shell: if ClankTalk can't do it, your agent can't do it.

- File access stays inside your project. Hidden files (`.env`, `.git/`) and your tool definitions are off limits.
- Programs your tools run can go in an OS sandbox (macOS, Linux).
- Git is built in, with hooks and other ways to run code turned off. Pushes ask you first.
- Fetch asks you before it talks to a new host.
- Every step is written to an audit log your agent can't change, and file changes can be undone.

## Install

ClankTalk runs as an [MCP](https://modelcontextprotocol.io) server. It needs Node 22 or later.

With Claude Code:

```bash
claude mcp add clank-talk -- npx -y -p clank-talk@0.2 clank-talk-mcp
claude --tools "" --allowedTools mcp__clank-talk
```

Any other MCP client:

```json
{
  "mcpServers": {
    "clank-talk": {
      "command": "npx",
      "args": ["-y", "-p", "clank-talk@0.2", "clank-talk-mcp"]
    }
  }
}
```

ClankTalk writes an audit log to `talk/audit/` in your project. Add it to your `.gitignore`.

Then give your agent tools in an `AGENTS.talk` at the root of your project:

```applescript
# Runs the tests.
tool run_tests
  run 'npm test' in a sandbox with local network
end
```

## Docs

- [Docs for humans](https://clank.talk/docs.html)
- [Docs for agents](https://clank.talk/reference.html)

ClankTalk is under construction. Expect things to change.

## License

[BSD-3-Clause](LICENSE)
