<div class="hero">
<div class="hero-title">clank<span class="hero-accent">-</span>talk</div>
<h1>A scripting language for AI agents</h1>
<p class="subtitle">TODO: one line pitch. Agents get a small, readable language in place of bash.</p>
<p class="subtitle">The runtime is the sandbox. Every step is audited, taint-tracked and undoable.</p>
</div>

<div class="window hero-code">
<div class="window-title">refactor.ct</div>

```
for file in files matching "src/**/*.js"
  read file into text
  if text contains "var "
    replace "var " with "let " in text
    write text to file
  end
end
```

</div>

<p class="note">Syntax is a sketch. It will change.</p>

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
<div class="window-title">taint.ct</div>

```
fetch https://example.com/data as json
-- the result is tainted: it came from the network
write the result to "data.json"
-- a hook asks the user first
```

</div>

## Undo

TODO: per-step undo stack, as far as is practical.

## Your Tools, In AGENTS.ct

TODO: users expose specific tools. The agent cannot change them.

<div class="window">
<div class="window-title">AGENTS.ct</div>

```
def run_tests()
  run "mvn test"
end
```

</div>

## Everything Is A Plugin

TODO: syntax and tools come from plugins that the user imports.

</div>
