<div class="features">

<img class="page-robot" src="img/clanktalk-robot.png" alt="A friendly robot">

<p><a href="./">Home</a> | <a href="reference.html">Docs for Agents</a> | <a href="https://github.com/bigskysoftware/clank-talk">GitHub</a> | <a href="https://github.com/sponsors/bigskysoftware">Sponsor</a></p>

# ClankTalk Docs

<ul class="areas">
<li><a href="#overview">Overview</a></li>
<li><a href="#install">Install</a></li>
<li><a href="#basic-usage">Basic Usage</a></li>
<li><a href="#files">Working With Files</a></li>
<li><a href="#tools">Tools</a></li>
<li><a href="#sandboxing">Sandboxing</a></li>
<li><a href="#oversight">Oversight</a></li>
<li><a href="#fine-print">The Fine Print</a></li>
</ul>

<div class="construction">

ClankTalk is under construction. Expect things to change.

</div>

<h2 id="overview">Overview</h2>

TODO (Carson): what ClankTalk is, in a few sentences.

- A scripting language for AI agents, used in place of a shell.
- **Agents write it. Humans read it.** It is not mainly for humans to write: it is built so that you can read what your agent did, at a glance.
- An xTalk language, like HyperTalk and [hyperscript](https://hyperscript.org): it reads like English on purpose.
- The runtime is the sandbox: no shell, no pipes, no `rm -rf`. If ClankTalk cannot do it, your agent cannot do it.

A script that an agent might write:

```talk
in @/src/config.js
  replace 'retries: 3' with 'retries: 5'

run_tests

if the result's code is not 0
  undo
end
```

TODO (Carson): walk through it: it changes a setting, runs the tests, and takes the change back if they fail.

- This page is for humans, and tells the story. The [docs for agents](reference.html) list every command, with examples. Agents get the same text from `help`.

<h2 id="install">Install</h2>

TODO (Carson): intro. ClankTalk runs as an [MCP](https://modelcontextprotocol.io) server with one tool, `clank_talk`, or as a pi package. Node 22 or later.

### Claude Code

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

Then take away the agent's other tools:

```bash
claude --tools "" --allowedTools mcp__clank-talk
```

TODO (Carson): explain the flags.

- `--tools ""` turns off the built-in tools (the shell, file edits), and keeps MCP tools. ClankTalk is then the only way in.
- Someone will forget the flags one day, so also tell the agent, in `AGENTS.md` (Claude Code reads it through a `CLAUDE.md` with the line `@AGENTS.md`). The note is a request; the flags are the rule.

```md
## Tools

Use the clank_talk tool for all work: reading, editing, search, git and tests.
Do not use a shell or other file tools.
If ClankTalk cannot do a task, stop and tell the human what is missing.
```

### pi

```bash
pi install -l git:github.com/bigskysoftware/clank-talk
```

TODO (Carson): pi notes.

- It runs inside pi: `ask` and fetch approvals are pi dialogs, and it turns off every other tool for you. No flags to forget.
- Try it once with no install: `pi -e git:github.com/bigskysoftware/clank-talk`.
- Careful with `pi install` without `-l`: every pi session on the machine then gets only ClankTalk.

### Other agents

TODO (Carson): Codex, Cursor and other MCP clients use the same server; see the install box on the [home page](./).

### Claude Code subagents

```bash
claude --tools "Agent" --strict-mcp-config --mcp-config .mcp.json --allowedTools mcp__clank-talk
```

TODO (Carson): subagent notes.

- Subagents get only the session's tools, so they get ClankTalk and nothing else.
- A custom subagent that lists `Glob` or `Grep` in its `tools:` gets them anyway: do not list them.
- Each subagent can pass its name as `agent`: it gets its own undo list and `$` variables, and the audit says who did what.

<h2 id="basic-usage">Basic Usage</h2>

TODO (Carson): intro. Your agent writes scripts; you read them, and you write `AGENTS.talk`.

### Your First Tool

Give your agent a way to run your tests, in `AGENTS.talk` at the root of your project:

```talk
# AGENTS.talk
allow env PATH, HOME

# Runs the full test suite.
tool run_tests
  run 'npm test' in a sandbox with local network
end
```

TODO (Carson): the comment above a tool is its help; the agent calls it by name.

### Watching Your Agent

```bash
tail -f .talk/audit/*.log
```

TODO (Carson): every step goes to `.talk/audit/`, one file a day, kept for 3 days (`keep audit for 7 days` in `AGENTS.talk` keeps more). Add `.talk/` to `.gitignore`. Put shared tool files in `talk/`.

<h3 id="reading">Reading a Script</h3>

TODO (Carson): a short tour for readers. The agent writes this; you need to read it.

- Comments start with `#`. Commands follow one another; `then` puts two on one line. Blocks close with `end`.
- `the` is optional. `robot's name`, `robot.name` and `the name of robot` are the same.
- Mixed math needs parentheses: `1 + 2 * 3` is an error, so nobody has to remember precedence.
- Most commands put their value in `it`, also called `the result`.
- A plain name is local to the script; a `$` name is a global that stays between scripts.

```talk
# this is a comment
set robot to {name: 'clank', tags: ['agent', 'robot']}
print 'Hello, ${robot's name}!'

if robot's tags contains 'agent'
  print 'an agent'
end

for item in [1, 2, 3] index i
  print '${i}: ${item}'
end
```

### Text and Code

TODO (Carson): how text looks in a script.

- Single or double quotes, with `${...}` for values. Their shared indent is removed.
- Code, and text with quotes, goes in a text block: lines that start with `|`, exactly as typed, with no escapes.

```talk
replace
| const retries = 3;
with
| const retries = 5;
in ./src/config.js
```

### Errors

```talk
read ./missing.txt
print 'this runs too'

on error
  print 'could not read: ' + the error's message
  continue
end
```

TODO (Carson): an error stops the script, unless `on error` catches it; `continue` goes on, `stop` (the default) ends it.

### How Your Agent Learns

```talk
help
help replace
help recipes
```

TODO (Carson): the agent asks `help` as it goes; `help recipes` shows good habits.

### Long Output

```talk
set failures to find 'not ok' in the previous output
```

TODO (Carson): the agent sees at most 1000 lines (less with `limit output to 400 lines` in `AGENTS.talk`); the next script gets all of it as `the previous output`.

<h2 id="files">Working With Files</h2>

TODO (Carson): intro to paths.

- `./notes.txt` and `../notes.txt` start from the current folder; `@/README.md` from the project root.
- `./src/**/*.js` gives a list of files, and skips `.git` and what git ignores.
- `./"my notes.txt"` holds spaces. A URL needs no quotes.
- Anything outside the project root is refused.
- A file has `name`, `path`, `text`, `lines`, `size` and `modified`.

```talk
for file in @/src/**/*.js
  if file contains 'TODO'
    print file's path
  end
end
```

### Finding Things

```talk
find 'TODO' in @/src/**/*.js
print first 10 of the result

set failures to find pattern 'not ok|FAIL' in the result's output
print sorted unique failures
```

TODO (Carson): `find` gives lines that know their number and file; `pattern` is a JavaScript regexp, stopped after 2 seconds.

### Changing Files

```talk
write 'hello' to ./out.txt
append ' world' to ./out.txt
replace 'var ' with 'let ' in ./src/**/*.js
move ./out.txt to ./notes/out.txt
delete ./notes/out.txt

in ./src/app.js do
  read
  print lines 10 to 12
  replace lines 11 to 11 with 'let x = 2'
  put '// added' after line 12
end
```

TODO (Carson): notes.

- `replace` changes every match, in one file or many, and warns if nothing matched.
- `move` never writes over a file; `git move` lets git see the rename.
- Edits by line number need a read first.
- You and your agent can work on the same files: if you save a file after the agent read it, its next write fails, and your change stays.

<h2 id="tools">Tools</h2>

TODO (Carson): you decide what your agent can run, in `AGENTS.talk`.

```talk
# AGENTS.talk
allow env PATH, HOME

# Runs one test file.
tool run_test with file
  run 'node' with '--test', file in a sandbox
end

# Starts the docs site.
tool site_server
  start 'npm run serve-site' as 'site' in a sandbox
end
```

```talk
set tests to run_test './test/app.test.js' within 5 minutes
if tests's code is not 0
  print find 'FAIL' in tests's output
end

site_server
wait until (fetch http://localhost:8000/ as response)'s status is 200 within 10 seconds
stop process 'site'
```

TODO (Carson): notes.

- `run` works only in a tool, never uses a shell, and passes on only the variables in `allow env`.
- A tool call is a value, so its answer can have a name.
- `start` keeps a program running; the agent can wait for it, read its output and stop it. The session's end stops them all.
- Share tools: put them in a `.talk` file, and `import ./talk/git.talk`.

<h2 id="sandboxing">Sandboxing</h2>

TODO (Carson): intro. What ClankTalk will not let your agent do, and how you can let it.

### Files It Cannot Change

```talk
# AGENTS.talk
allow changes to @/.github/, @/.gitignore
```

TODO (Carson): scripts cannot change `.talk` files (so the agent cannot change its tools) or hidden files (`.env`, `.git/`, `.github/`); the agent tells you the line to add. `.env` files cannot even be read.

### Programs in an OS Sandbox

```talk
# AGENTS.talk
tool install
  run 'npm install' in a sandbox with network, writes to '~/.npm'
end
```

TODO (Carson): notes.

- Your agent writes code, and `npm test` runs code, so a test tool can run anything the agent writes. That is why tools say `in a sandbox`.
- In a sandbox: writes only to the project (not `.git`, `.talk` or hidden files), reads only system folders, install folders and caches, no network, and a fresh home folder.
- Options: `with network`, `with local network`, `writes to <path>`, `reads of <path>`.
- macOS (`sandbox-exec`) and Linux (`bubblewrap`). Elsewhere a sandboxed `run` is an error; it never runs without the sandbox. A self-test runs first.
- Ubuntu 23.10 and later: AppArmor can block `bubblewrap`. Fix: `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, or an AppArmor profile for `bwrap`.

### Git

```talk
git status
git switch to new branch 'fix-parser'
git commit [./src/app.js, ./test/app.test.js] with 'Fix the parser'
git switch to 'main'
git merge 'fix-parser'
```

TODO (Carson): commit takes only named files; merge only fast-forwards; rebase is all or nothing; push sends the current branch, never with force; hooks, pagers and filters are off.

### Fetch

```talk
# AGENTS.talk
allow fetch from 'api.github.com', '*.npmjs.org', 'localhost'
```

TODO (Carson): the first fetch to a new host asks you; `localhost` and private addresses must be listed; each redirect goes into the audit.

<h3 id="secrets">Secrets</h3>

```talk
# AGENTS.talk
allow secret GITHUB_TOKEN for fetch to 'api.github.com'
allow secret NPM_TOKEN for run

tool publish
  run 'npm publish' using secret NPM_TOKEN
end
```

```talk
fetch https://api.github.com/user as json with headers: { Authorization: 'Bearer ' + secret GITHUB_TOKEN }
```

TODO (Carson): notes.

- The agent uses a key by name, and never sees it: print shows `<secret GITHUB_TOKEN>`, and any other use is an error.
- Values come from the environment, then `.env.local`, then `.env`.
- A value that comes back (output, responses, errors, the audit) shows as `<secret NAME>`.
- Risks: a program with a secret and the network can send it anywhere. Give secrets only to programs whose code the agent cannot change (`npm publish` runs scripts from `package.json`).

<h3 id="taint">Taint</h3>

```talk
# AGENTS.talk
untrusted tool issue with id
  run 'gh' with 'issue', 'view', id
end
```

```talk
set page to fetch https://example.com/notes
if page is untrusted
  print 'This came from the web'
end
```

TODO (Carson): notes.

- `untrusted`: text from fetch, an `untrusted tool`, or a subagent. `private`: text from files, git and programs.
- Labels follow values, and stay with files you write (`.talk/taint.json`).
- Untrusted text in `run`, `start` or git asks you first; private text in a fetch asks once for each host.
- Limits: the agent can retype what it read; an `if` passes no labels; taint cannot see inside a program.

### Subagents

```talk
# AGENTS.talk
untrusted tool gh_issues with query
  run 'gh' with 'issue', 'list', '--search', query
end

# Summarizes the most important open issues.
tool summarize_issues
  run 'Summarize the most important open issues' in a subagent with only gh_issues
end
```

TODO (Carson): notes.

- A model that can call only the tools after `with only`, and those tools cannot write, fetch or use git.
- Its answer is always untrusted.
- In pi it uses pi's model; elsewhere it needs `use model 'claude-sonnet-5-5' for subagents with secret ANTHROPIC_API_KEY`.
- `start '...' as 'issues' in a subagent with only gh_issues` runs it in the background.

<h2 id="oversight">Oversight</h2>

TODO (Carson): intro. You stay in charge: questions, hooks, the audit and undo.

### Asking You

```talk
ask 'Delete the old logs?' with 'yes' or 'no' within 5 minutes
if the result is 'yes'
  print 'ok'
end
```

TODO (Carson): only you answer; no answer is `null`, which means no.

<h3 id="hooks">Hooks</h3>

```talk
# AGENTS.talk
before run
  if the run's sandbox is null
    reject 'Use a sandbox'
  end
end
```

TODO (Carson): your security policy is code you can read; `before` hooks can `reject` a step; a hook can watch any step or tool.

<h3 id="audit">Audit</h3>

```text
== 10:42:01  session claude-code-4f2a  script 12 (main)  done  6 steps ==
  in @/src/config.js
    replace 'retries: 3' with 'retries: 5'
  run_tests
--
10:42:01  replace  src/config.js                             undo saved
10:42:01  tool     run_tests
10:42:09  run      npm test                                  in a sandbox with local network, code 0, 7.9 s, from run_tests
```

TODO (Carson): the agent cannot change it; `audit as json` for tools; `the audit` lets the agent read its own steps.

<h3 id="undo">Undo</h3>

```talk
undo
undo 3
undo changes to ./src/app.js
print the undo list
```

TODO (Carson): undo works across scripts in a session, and touches nothing that changed since; it covers file changes, not programs or commits.

### Policies

TODO (Carson): for teams and harness owners: a policy file sets limits that `AGENTS.talk` cannot widen (`deny`, `limit ... to`, `require sandbox`).

<h2 id="fine-print">The Fine Print</h2>

TODO (Carson): the honest limits.

- A `run` without `in a sandbox` is where the sandbox ends.
- The sandbox limits files and the network, not CPU or memory.
- On Linux, the sandbox protects hidden files and `.talk` files only at the top of the project, and only those that exist when the program starts.
- Web pages and tool output can try to steer your agent. ClankTalk keeps the damage small, but cannot stop the agent from believing what it reads.

</div>

