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
replace
| total = price * qty
with
| total = price * qty * (1 - off)
in @/src/cart.js

run_tests
```

```talk
set tests to run_tests
set fails to find 'not ok'
  in tests's output

print first 10 of fails
```

```talk
git commit [./src/cart.js]
  with 'Fix the total'
git switch to 'main'
git merge 'fix-total'
git push
git delete branch 'fix-total'
```

```talk
site_server
set home to http://localhost:8000/
wait until the status of fetch home as response
  is 200 within 20 seconds

print process 'site'
```

</div>
<img src="img/clanktalk-robot.png" alt="A friendly robot">
</div>
<p class="subtitle">ClankTalk replaces <a href="docs.html#overview">the wild west of a shell</a> with <a href="docs.html#tools">a small, readable tool language</a> that works with <a href="docs.html#install">any agent in any harness</a>. Your agents get the tools they need to get work done. You get <a href="docs.html#reading">readable</a>, <a href="docs.html#audit">auditable</a> actions, <a href="docs.html#sandboxing">sandboxes</a>, <a href="docs.html#hooks">security hooks</a>, <a href="docs.html#taint">taint tracking</a>, <a href="docs.html#undo">undo</a>, <a href="docs.html#secrets">secrets support</a> and <a href="docs.html">more</a>.</p>
<p class="subtitle"><a href="docs.html">Docs for Humans</a> &middot; <a href="reference.html">Docs for Agents</a> &middot; <a href="https://github.com/bigskysoftware/clank-talk">GitHub</a> &middot; <a href="https://github.com/sponsors/bigskysoftware">Sponsor</a></p>
<div class="install">
<div class="install-picker">
<span class="install-label">Install for</span>
<button class="install-button" type="button" aria-haspopup="listbox" aria-expanded="false"><span class="agent-icon claude">C</span><span class="install-name">Claude Code</span><span class="install-chevron"></span></button>
<ul class="install-menu" role="listbox" hidden>
<li role="option" tabindex="0" data-agent="claude"><span class="agent-icon claude">C</span>Claude Code</li>
<li role="option" tabindex="0" data-agent="pi"><span class="agent-icon pi">&pi;</span>pi</li>
<li role="option" tabindex="0" data-agent="codex"><span class="agent-icon codex">O</span>Codex</li>
<li role="option" tabindex="0" data-agent="opencode"><span class="agent-icon other">O</span>opencode (experimental)</li>
<li role="option" tabindex="0" data-agent="other"><span class="agent-icon other">M</span>Other MCP clients</li>
</ul>
</div>
<div class="install-code">
<button class="install-copy" type="button">Copy</button>
<pre data-agent="claude"><code># add the server
claude mcp add clank-talk -- npx -y -p clank-talk@0.1 clank-talk-mcp
# then, in Claude Code, add the plugin: /taint, /clank-talk, and the guard
/plugin install clank-talk --marketplace bigskysoftware/clank-talk</code></pre>
<pre data-agent="pi" hidden><code># install the ClankTalk package for this project
pi install -l git:github.com/bigskysoftware/clank-talk</code></pre>
<pre data-agent="codex" hidden><code># add the server
codex mcp add clank-talk -- npx -y -p clank-talk@0.1 clank-talk-mcp
# check that it is there
codex mcp list</code></pre>
<pre data-agent="opencode" hidden><code># experimental, opencode V2: install the package in your project
npm install --save-dev clank-talk
# then load the plugin in opencode.jsonc
{ "plugins": ["./node_modules/clank-talk/src/js/harnesses/opencode"] }</code></pre>
<pre data-agent="other" hidden><code>{
  "mcpServers": {
    "clank-talk": {
      "command": "npx",
      "args": ["-y", "-p", "clank-talk@0.1", "clank-talk-mcp"]
    }
  }
}</code></pre>
</div>
</div>
<script src="js/install.js"></script>
<script src="js/hero.js"></script>
</div>

<div class="features showcase">

## Readable Scripts

ClankTalk is designed for your agent to write and _you_ to read.  It is optimized for human understanding, while allowing agents to get work done efficiently.

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

## A Controlled, Observable Runtime

Giving an agent a shell is pretty crazy when you think
about it. ClankTalk gives it a controlled & observable runtime instead:

- File access stays inside the project root
- Secrets and config that runs code, like `.env` and `.git/`, are off limits
- You can lock down `fetch` with your own rules
- Step budgets control run away loops

```talk escape.talk
write 'hello' to ../../etc/hosts
# error: outside the project root
```

## Define Your Agent's Tools

You can define new tools in `AGENTS.talk` for your agents that allow you to minimize the surface area
needed to get work done.  Agents aren't allowed to touch `.talk` files or hidden files by default.

```talk AGENTS.talk
tool site_server
  start 'npm run dev' as 'site' in a sandbox
end
```

## OS Sandboxes for Programs

When available (MacOS, Linux) and needed, tools can run programs in OS level sandboxes.

```talk AGENTS.talk
tool run_tests
  run 'npm test' in a sandbox with local network
end
```

## Secret Secrets

Allow your agents to use secrets without seeing them in a controlled manner. 

Secrets come from `.env`, which scripts cannot read, and can only be used in places defined in your `AGENTS.talk`.

```talk github.talk
set auth to 'Bearer ' + secret GITHUB_TOKEN
fetch https://api.github.com/user with headers: { Authorization: auth }

print auth
# Bearer <secret GITHUB_TOKEN>

print auth contains 'ghp'
# error: a secret cannot go into 'contains'
```

## Coherent Security Policy

You can define a sophisticated security policy for your project (or company!)

In `AGENTS.talk`, `allow` lines say what your agent can reach, and hooks run logic before and after every agent action.

```talk AGENTS.talk
allow env PATH, HOME
allow changes to @/.github/
allow fetch from 'api.github.com', 'registry.npmjs.org'
allow secret NPM_TOKEN for run

before git
  if the git's operation is 'commit'
    ask 'Commit ' + the git's files + '?' with 'yes' or 'no'
    if the result is not 'yes'
      reject 'The human said no'
    end
  end
end
```

## Audit Logs

ClankTalk adds _observability_ to your agent's sessions by keeping a log (default of three days) of every action your agent takes.

```audit .talk/audit/2026-11-09.log
== 10:42:01  script 12 (main)  done  4 steps ==
  replace
  | total = price * qty
  with
  | total = price * qty * (1 - off)
  in @/src/cart.js

  run_tests
--
10:42:01  read     src/cart.js
10:42:01  replace  src/cart.js  undo saved
10:42:01  tool     run_tests
10:42:09  run      npm test     code 0, 7.9 s, from run_tests
```

## Undo

The ClankTalk runtime makes an undo stack available to 
allow you or the agent to back out any changes made on
disk easily, even if you aren't using git.

```talk undo.talk
replace 'retries: 3' with 'retries: 5' in ./src/config.js
set tests to run_tests
if tests's code is not 0
  # the change broke the tests: take it back
  undo
end

# or go back further, or one file only
undo 3
undo changes to ./src/config.js
```

## Hardened Git

Git tools come built in, with the parts that run programs turned off.  This allows you to use the 80%
of git that matters without the 20% of git that can
be used to compromise you.

```talk fix.talk
git switch to new branch 'fix-retries'
replace 'retries: 3' with 'retries: 5' in ./src/config.js
git diff ./src/config.js
print it
git commit [./src/config.js] with 'More retries'
git rebase onto 'main'
git push
# no hooks, no pager, no external diff, and
# a repo config that runs programs stops git
```

## Taint Tracking

Taint tracking allows you to follow when outside, untrusted and "tainted" text has entered into the agent's environment, and to control how things work
after that happens.

```talk triage.talk
fetch https://example.com/issues/42
git push
# asks you: Push to origin? 1 untrusted input
#   is not approved: https://example.com/issues/42
```

ClankTalk taints the whole session, not just the text, and keeps a copy of each untrusted input your agent read.  You can review and approve them from your terminal, with `npx clank-talk taint`, or right in your harness, with `taint review`.

## Agent & Harness Agnostic

ClankTalk is implemented as an [MCP](https://modelcontextprotocol.io) server, so it works with _any_ agent in _any_ harness. 

You can turn off your other tools and ClankTalk becomes
the only way your agent can interact with your system.

```bash terminal
claude mcp add clank-talk -- npx -y -p clank-talk@0.1 clank-talk-mcp
# in Claude Code
/plugin install clank-talk --marketplace bigskysoftware/clank-talk
```


<div class="construction">

ClankTalk is under construction. Expect things to change.
Thanks for your patience!

</div>

</div>
