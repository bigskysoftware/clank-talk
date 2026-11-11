<img src="docs/img/readme-hero.png" alt="A friendly robot says a ClankTalk script: in @/src/config.js, replace 'retries: 3' with 'retries: 5'. Run the tests. If the result's code is not 0, undo." width="700">

# Clank*Talk*

ClankTalk is a scripting language for agents to write and humans to read.  It replaces shell.

It's an [xTalk](https://en.wikipedia.org/wiki/HyperTalk) language, so it reads like English.  You might not want to *write* code that way, but then your agent is the one writing it, not you.  

You just have to read it.

With no shell and the ClankTalk runtime, you get a lot more control: file access stays inside your project, programs run only through tools you define (in an OS sandbox, if you like), and your agent can use secrets without seeing them.  

The runtime supports hooks, taint tracking, an audit log and an undo stack.

## Install

ClankTalk runs as an [MCP](https://modelcontextprotocol.io) server and requires Node 22 or higher.

Claude Code:

```bash
claude mcp add clank-talk -- npx -y -p clank-talk@0.1 clank-talk-mcp
claude --tools "" --allowedTools mcp__clank-talk
```

pi:

```bash
# install for this project only (without -l, every pi session on your machine gets it)
# removes all other tools besides clank-talk!
pi install -l git:github.com/bigskysoftware/clank-talk

# run pi once without any extensions, ClankTalk included
pi -ne

# turn ClankTalk on or off for this project
pi config --local

# remove it from this project
pi remove -l git:github.com/bigskysoftware/clank-talk
```

Other MCP clients, such as Cursor (`.cursor/mcp.json` in your project), take a config like this.  Codex takes the same values in `~/.codex/config.toml`, and the [install docs](https://clank.talk/docs.html#install) show each one.

```json
{
  "mcpServers": {
    "clank-talk": {
      "command": "npx",
      "args": ["-y", "-p", "clank-talk@0.1", "clank-talk-mcp"]
    }
  }
}
```

## Docs

- [Docs for humans](https://clank.talk/docs.html)
- [Docs for agents](https://clank.talk/reference.html)

## Contributing

Pull requests are open to collaborators only for now. 

Please open an [issue](https://github.com/bigskysoftware/clank-talk/issues) for bugs and ideas.

## Sponsor

ClankTalk is made by [Big Sky Software](https://github.com/bigskysoftware). 

To support the work, [sponsor us on GitHub](https://github.com/sponsors/bigskysoftware).

## License

[BSD-3-Clause](LICENSE)
