<div class="hero">
<div class="hero-title">Clank<span class="hero-accent">Talk</span></div>
<h1>Sandboxed Scripting for Agents</h1>
<div class="hero-art">
<div class="hero-bubble">

```talk
for file in ./src/**/*.js
  if the file's text contains 'var '
    replace it with 'let '
  end
end
```

</div>
<img src="img/clanktalk-robot.png" alt="A friendly robot">
</div>
<p class="note">Syntax is a sketch. It will change.</p>
<p class="subtitle">ClankTalk provides a controlled scripting environment to replace the wild west of arbitrary system manipulation. It provides infrastructure for security hooks, auditing, taint tracking while providing agents the tools necessary to accomplish work.</p>
</div>

<div class="features">

## Easy To Read

TODO: humans can read what the agent did. Based on [hyperscript](https://hyperscript.org).

## The Runtime Is The Sandbox

TODO: no bash, no general exec. Built-in file system and fetch, scoped to a root.

## Full Audit

TODO: every action is recorded. A second agent can summarize it.

<div class="window">
<div class="window-title">audit</div>

```
step 1  read   src/app.js
step 2  write  src/app.js      undo: 1
step 3  fetch  example.com     taint: network
```

</div>

## Taint Tracking

TODO: values remember where they came from. Hooks decide what tainted values can reach.

<div class="window">
<div class="window-title">taint.talk</div>

```talk
fetch https://example.com/data as json
-- the result is tainted: it came from the network
write the result to "data.json"
-- a hook asks the user first
```

</div>

## Undo

TODO: per-step undo stack, as far as is practical.

## Your Tools, In AGENTS.talk

TODO: users expose specific tools. The agent cannot change them.

<div class="window">
<div class="window-title">AGENTS.talk</div>

```talk
def run_tests()
  run "mvn test"
end
```

</div>

## Everything Is A Plugin

TODO: syntax and tools come from plugins that the user imports.

</div>
