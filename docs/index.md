<div class="hero">
<div class="hero-title">Clank<span class="hero-accent">Talk</span></div>
<h1>Sandboxed Scripting for Agents</h1>
<div class="hero-art">
<div class="hero-bubble">

```talk
for file in ./src/**/*.js
  if the file's text contains 'var '
    replace 'var ' with 'let ' in the file
  end
end
```

</div>
<img src="img/clanktalk-robot.png" alt="A friendly robot">
</div>
<p class="note">Syntax is a sketch. It will change.</p>
<p class="subtitle"><a href="docs.html">Read the docs</a></p>
<p class="subtitle">ClankTalk provides a controlled scripting environment to replace the wild west of arbitrary system manipulation. It provides infrastructure for security hooks, auditing, taint tracking while providing agents the tools necessary to accomplish work.</p>
</div>

<div class="features">

## Easy To Read

Agents write a lot of bash. Somebody has to read it. That somebody is you.

ClankTalk is an xTalk language, inspired by HyperTalk and [hyperscript](https://hyperscript.org).
It reads like English, so you can tell what your agent did at a glance.

<div class="compare">
<div class="window">
<div class="window-title">bump.sh</div>

```bash
for f in ./config/*.json; do
  v=$(jq -r '.version' "$f")
  if [ "$v" -lt 2 ]; then
    jq '.version = 2' "$f" > "$f.tmp" \
      && mv "$f.tmp" "$f"
  fi
done
```

</div>
<div class="window">
<div class="window-title">bump.talk</div>

```talk
for file in ./config/*.json
  set config to the file's text as json
  if config's version is less than 2
    set config's version to 2
    write config as json to the file
  end
end
```

</div>
</div>

## The Runtime Is The Sandbox

Giving an agent a shell is giving it the keys to your machine. ClankTalk gives it a language instead.

The runtime is pure JavaScript. No bash, no exec, no escape hatches. If ClankTalk can't do it, your agent can't do it.

- File access stays inside the project root
- Fetch only talks to hosts you allow
- Runaway loops hit a step budget and stop

<div class="window">
<div class="window-title">escape.talk</div>

```talk
write 'hello' to ../../etc/hosts
# error: Path is outside the project root: ../../etc/hosts
```

</div>

## Full Audit

Ever wonder what your agent is actually doing? Wonder no more.

Every step is recorded: what ran, what it touched and where the data came from.
Read the log yourself, or hand it to another agent to summarize.

<div class="window">
<div class="window-title">audit</div>

```
#1  read   ./config/app.json
#2  write  ./config/app.json     undo: saved
#3  fetch  https://example.com   taint: network
#4  run    run_tests             from: AGENTS.talk
```

</div>

## Taint Tracking

Values remember where they came from. Anything from the network is tainted, and taint sticks.

When tainted data heads somewhere sensitive, your hooks get a say.

<div class="window">
<div class="window-title">taint.talk</div>

```talk
fetch https://example.com/data as json
# the result is tainted: it came from the network
write the result to ./data.json
# a hook asks the user first
```

</div>

## Security Hooks

Security policy should be code you can read.

Hooks live in `AGENTS.talk`, right next to your tools, and run before and after every step. Allow it, reject it, or ask the user.

<div class="window">
<div class="window-title">AGENTS.talk</div>

```talk
before write
  if the write's path ends with '.env'
    reject 'Cannot update env files!'
  end
end
```

</div>

## Undo

Agent made a mess? Undo it.

ClankTalk saves file changes before it makes them, so you can roll agent work back one step at a time.

<div class="window">
<div class="window-title">undo.talk</div>

```talk
undo the last 2 steps
```

</div>

## Your Tools, In AGENTS.talk

Sometimes your agent really does need to run something, like your test suite. Fine!

Define a tool in `AGENTS.talk`. The agent can call it. The agent can't change it. Everything else stays off limits.

<div class="window">
<div class="window-title">AGENTS.talk</div>

```talk
tool run_tests
  run 'mvn test'
end
```

</div>

## Share Your Tools

Tools are just ClankTalk, so they're easy to read and easy to share. Pull in a whole set with `import`.

You pick the imports. Your agent doesn't, and it can't touch a `.talk` file.

<div class="window">
<div class="window-title">AGENTS.talk</div>

```talk
import ./tools/git.talk
```

</div>

## Works With Your Agent

ClankTalk has a general host API, so it can plug into any agent. First up: an extension for [pi](https://github.com/badlogic/pi-mono).

More hosts to come.

<div class="construction">

ClankTalk is under construction. The syntax on this page is a sketch, and it <em>will</em> change.
Thanks for your patience!

</div>

</div>
