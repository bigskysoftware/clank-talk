<div class="hero">
<div class="hero-title">Clank<span class="hero-accent">Talk</span></div>
<h1>Sandboxed Scripting for Agents</h1>
<div class="hero-art">
<div class="hero-bubble">

```talk
replace 'retries: 3'
   with 'retries: 5'
   in @/src/config.js

run_tests

if the result's code is not 0
  undo
end
```

</div>
<img src="img/clanktalk-robot.png" alt="A friendly robot">
</div>
<p class="subtitle"><a href="docs.html">Docs for Humans</a> &middot; <a href="reference.html">Docs for Agents</a> &middot; <a href="https://github.com/bigskysoftware/clank-talk">GitHub</a></p>
<p class="subtitle">ClankTalk replaces the wild west of a shell with a small, readable language. Your agent gets the tools it needs to do real work. You get sandboxes, security hooks, undo, and the final say.</p>
</div>

<div class="features">

## Easy To Read

Agents write a lot of bash. Somebody has to read it. That somebody is you.

ClankTalk is an xTalk language, inspired by HyperTalk and [hyperscript](https://hyperscript.org).
It reads like English, so you can tell what your agent did at a glance.

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

## The Runtime Is The Sandbox

Giving an agent a shell is giving it the keys to your machine. ClankTalk gives it a language instead.

The runtime is pure JavaScript. No bash, no exec, no escape hatches. If ClankTalk can't do it, your agent can't do it.

- File access stays inside the project root
- Secrets and config that runs code, like `.env` and `.git/`, are off limits
- Fetch asks you before it talks to a new host
- Runaway loops hit a step budget and stop

```talk escape.talk
write 'hello' to ../../etc/hosts
# error: Path is outside the project root: ../../etc/hosts
```

## Real Sandboxes For Real Programs

Your tests run code, and your agent writes code. So when a tool runs a program, put it in a sandbox: it can write your project, and nothing else. No home folder, no secrets, no network, unless you say so.

On an OS where ClankTalk can't prove the sandbox holds, the program doesn't run. Ever.

```talk AGENTS.talk
tool run_tests
  run 'npm test' in a sandbox with local network
end
```

## Git, Without The Footguns

Git is built in, with the parts that run programs turned off. Your agent commits only the files it names, merges only by fast-forward, and pushes only when you say yes.

```talk fix.talk
git switch to new branch 'fix-retries'
git commit [./src/config.js] with 'More retries'
git push
# dialog: Push branch 'fix-retries' to origin?  yes / no
```

## You Stay In Charge

Security policy should be code you can read. Hooks live in `AGENTS.talk`, right next to your tools, and run before and after every step. Allow it, reject it, or ask you.

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

Only you answer `ask`, never the agent. If nobody answers, the answer is no.

## Undo

Agent made a mess? Undo it.

ClankTalk saves file changes before it makes them, so you can roll agent work back one script at a time.

```talk undo.talk
undo 2
undo changes to ./src/config.js
```

## Your Tools, In AGENTS.talk

Sometimes your agent really does need to run something, like your test suite or a dev server. Fine!

Define a tool in `AGENTS.talk`. The agent can call it. The agent can't change it. Everything else stays off limits.

```talk AGENTS.talk
tool site_server
  start 'npm run dev' as 'site' in a sandbox
end
```

## Share Your Tools

Tools are just ClankTalk, so they're easy to read and easy to share. Pull in a whole set with `import`.

You pick the imports. Your agent doesn't, and it can't touch a `.talk` file.

```talk AGENTS.talk
import ./tools/deploy.talk
```

## Works With Your Agent

ClankTalk is an [MCP](https://modelcontextprotocol.io) server, so it works with Claude Code and any other agent that speaks MCP. Turn off your agent's shell, and ClankTalk is the only way in.

```bash terminal
claude --tools "" --allowedTools mcp__clank-talk
```

## Coming Soon

- **Audit:** a log of every step: what ran, what it touched, and where the data came from
- **Taint tracking:** values remember where they came from, so data from the web can't sneak into places it shouldn't
- **Secrets:** your agent uses an API key by name, and never sees it

<div class="construction">

ClankTalk is under construction. Expect things to change.
Thanks for your patience!

</div>

</div>
