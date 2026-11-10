<div class="hero">
<div class="hero-title">Clank<span class="hero-accent">Talk</span></div>
<h1>Sandboxed Scripting for Agents</h1>
<div class="hero-art">
<div class="hero-bubble">

```talk
in @/src/config.js
  replace 'retries: 3' with 'retries: 5'

run_tests

if the result's code is not 0
  undo
end
```

```talk
git diff
print it

ask 'Commit these changes?' with 'yes' or 'no'
if the result is 'yes'
  git commit [./src/app.js] with 'Fix retries'
end
```

```talk
set hits to find 'TODO' in ./src/**/*.js

for line in hits
  print line
end
```

```talk
fetch https://api.example.com/status as json

if the result's ok is not true
  ask 'The API is down. Deploy anyway?'
end
```

</div>
<img src="img/clanktalk-robot.png" alt="A friendly robot">
</div>
<div class="install">
<div class="install-picker">
<span class="install-label">Install for</span>
<button class="install-button" type="button" aria-haspopup="listbox" aria-expanded="false"><span class="agent-icon claude">C</span><span class="install-name">Claude Code</span><span class="install-chevron"></span></button>
<ul class="install-menu" role="listbox" hidden>
<li role="option" tabindex="0" data-agent="claude"><span class="agent-icon claude">C</span>Claude Code</li>
<li role="option" tabindex="0" data-agent="cursor"><span class="agent-icon cursor">C</span>Cursor</li>
<li role="option" tabindex="0" data-agent="codex"><span class="agent-icon codex">O</span>Codex</li>
<li role="option" tabindex="0" data-agent="pi"><span class="agent-icon pi">&pi;</span>pi</li>
<li role="option" tabindex="0" data-agent="other"><span class="agent-icon other">M</span>Other MCP clients</li>
</ul>
</div>
<div class="install-code">
<button class="install-copy" type="button">Copy</button>
<pre data-agent="claude"><code># add the server
claude mcp add clank-talk -- npx -y -p clank-talk@0.2 clank-talk-mcp
# start Claude Code with ClankTalk as its only tool
claude --tools "" --allowedTools mcp__clank-talk</code></pre>
<pre data-agent="cursor" hidden><code>// .cursor/mcp.json
{
  "mcpServers": {
    "clank-talk": {
      "command": "npx",
      "args": ["-y", "-p", "clank-talk@0.2", "clank-talk-mcp"]
    }
  }
}</code></pre>
<pre data-agent="codex" hidden><code># ~/.codex/config.toml
[mcp_servers.clank-talk]
command = "npx"
args = ["-y", "-p", "clank-talk@0.2", "clank-talk-mcp"]</code></pre>
<pre data-agent="pi" hidden><code># coming soon: a ClankTalk extension for pi</code></pre>
<pre data-agent="other" hidden><code>{
  "mcpServers": {
    "clank-talk": {
      "command": "npx",
      "args": ["-y", "-p", "clank-talk@0.2", "clank-talk-mcp"]
    }
  }
}</code></pre>
</div>
</div>
<script src="js/install.js"></script>
<script src="js/hero.js"></script>
<p class="subtitle"><a href="docs.html">Docs for Humans</a> &middot; <a href="reference.html">Docs for Agents</a> &middot; <a href="https://github.com/bigskysoftware/clank-talk">GitHub</a></p>
<p class="subtitle">ClankTalk replaces the wild west of a shell with a small, readable, Agent & harness agnostic tool language. Your agents get the tools they need to do real work. You get readable, auditable actions, sandboxes, security hooks, undo, and the final say in your agentic security profile.</p>
</div>

<div class="features showcase">

## Human Readable

ClankTalk is an xTalk language, inspired by [hyperscript](https://hyperscript.org).

It reads like English, so you can tell what your agent did at a glance.  Bash... not so much.

<div class="compare">

```bash bump.sh
for f in ./config/*.json; do
  v=$(jq -r '.version' "$f")
  if [ "$v" -lt 2 ]; then
    jq '.version = 2' "$f" > "$f.tmp" \
      && mv "$f.tmp" "$f"
  fi
done
```

```talk bump.talk
for file in ./config/*.json
  set config to the file's text as json
  if config's version is less than 2
    set config's version to 2
    write config as json to the file
  end
end
```

</div>
<script src="js/compare.js"></script>

## A Customizable Agent Sandbox

Giving an agent a shell is giving it the keys to your kingdom. ClankTalk gives it a controlled & observable language instead.

The runtime is pure JavaScript:

- File access stays inside the project root
- Secrets and config that runs code, like `.env` and `.git/`, are off limits
- Fetch asks you before it talks to a new host
- Runaway loops hit a step budget and stop

```talk escape.talk
write 'hello' to ../../etc/hosts
# error: outside the project root
```

## Your Tools, In AGENTS.talk

Sometimes your agent really does need to run something, like your test suite or a dev server. Fine!

Define a tool in `AGENTS.talk`. The agent can call it. The agent can't change it. Everything else stays off limits.

```talk AGENTS.talk
tool site_server
  start 'npm run dev' as 'site' in a sandbox
end
```

## Real OS Sandboxes For Real Programs

When available & needed, tools can run programs in OS level sandboxes.

```talk AGENTS.talk
tool run_tests
  run 'npm test' in a sandbox with local network
end
```

## Agent Security Sovereignty

Your agent security policy is code you can read. Hooks live in `AGENTS.talk`, right next to your tools, and run before and after every step.

Allow it, reject it, or ask you. Only you answer `ask`, never the agent. If nobody answers, the answer is no.

```talk AGENTS.talk
before git
  if the git's operation is 'commit'
    ask 'Commit ' + the git's files + '?' with 'yes' or 'no'
    if the result is not 'yes'
      reject 'The human said no'
    end
  end
end
```

## Full Audit

Ever wonder what your agent is actually doing? Wonder no more.

Every step that touches the world is written to `talk/audit/`: what ran, what it touched, and where. Your agent can't change it.

```text talk/audit/2026-11-09.log
10:42:01  replace  src/config.js   undo saved
10:42:01  tool     run_tests
10:42:09  run      npm test        code 0, 7.9 s
```

## Undo

Agent made a mess? Undo it.

ClankTalk saves file changes before it makes them, so you can roll agent work back one script at a time.

```talk undo.talk
undo 2
undo changes to ./src/config.js
```

## Git, Without The Footguns

Git is built in, with the parts that run programs turned off. Your agent commits only the files it names, and merges only by fast-forward.

```talk fix.talk
git switch to new branch 'fix-retries'
git commit [./src/config.js] with 'More retries'
git push
```

## Works With Your Agent

ClankTalk is an [MCP](https://modelcontextprotocol.io) server, so it works with Claude Code or any other agent that speaks MCP. Turn off your agent's shell, and ClankTalk is the only way in.

```bash terminal
claude --tools "" --allowedTools mcp__clank-talk
```

## Share Your Tools

Tools are just ClankTalk, so they're easy to read and easy to share. Pull in a whole set with `import`.

You pick the imports. Your agent doesn't, and it can't touch a `.talk` file.

```talk AGENTS.talk
import ./tools/deploy.talk
```

## Coming Soon

- **Taint tracking:** values remember where they came from, so data from the web can't sneak into places it shouldn't
- **Secrets:** your agent uses an API key by name, and never sees it

<div class="construction">

ClankTalk is under construction. Expect things to change.
Thanks for your patience!

</div>

</div>
