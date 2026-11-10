<div class="features">

<p><a href="./">Home</a> | <a href="reference.html">Docs for Agents</a> | <a href="https://github.com/bigskysoftware/clank-talk">GitHub</a></p>

# ClankTalk Docs

## Introduction

ClankTalk is a scripting language for AI agents. You give your agent ClankTalk, in place of a shell.

Here is a script an agent might write:

```talk
in @/src/config.js
  replace 'retries: 3' with 'retries: 5'

run_tests

if the result's code is not 0
  undo
end
```

It changes a setting, runs the tests, and if they fail, takes the change back.

The first thing you probably noticed is that it reads like English. ClankTalk is a member of the [xTalk](https://en.wikipedia.org/wiki/XTalk) family, like HyperTalk and [hyperscript](https://hyperscript.org). That's on purpose: the agent writes the script, but *you* have to read it.

The second thing you might notice is what's missing: no shell, no pipes, no `rm -rf`. The runtime is the sandbox. If ClankTalk can't do it, your agent can't do it.

This page is for humans: it tells the story. The [docs for agents](reference.html) list every command and expression, with examples. Your agent gets the same text from `help`.

<div class="construction">

ClankTalk is under construction. Expect things to change.

</div>

## Getting Started

ClankTalk runs as an [MCP](https://modelcontextprotocol.io) server with one tool, `clank_talk`. It needs Node 22 or later. Point your agent at it with a `.mcp.json` in your project:

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

Then take away the agent's other tools. With Claude Code:

```bash
claude --tools "" --allowedTools mcp__clank-talk
```

`--tools ""` turns off the built-in tools (the shell, file edits, and so on), and keeps MCP tools. Now ClankTalk is the only way your agent can touch your machine.

But someone on your team will forget the flags one day. So tell the agent too, in your `AGENTS.md`:

```md
## Tools

Use the clank_talk tool for all work: reading, editing, search, git and tests.
Do not use a shell or other file tools.
If ClankTalk cannot do a task, stop and tell the human what is missing.
```

Claude Code reads `CLAUDE.md`, not `AGENTS.md`. A `CLAUDE.md` with the line `@AGENTS.md` pulls it in. A note is only a request, though: the flags above are what make it a rule.

Next, give your agent a way to run your tests, in an `AGENTS.talk` at the root of your project:

```talk
# AGENTS.talk
allow env PATH, HOME

# Runs the full test suite.
tool run_tests
  run 'npm test' in a sandbox with local network
end
```

Want to see what your agent is up to? Every step goes to an audit log in `talk/audit/`, one file a day. Add that folder to your `.gitignore`, and watch it:

```bash
tail -f talk/audit/*.log
```

### Subagents

Some agents start helpers of their own. With Claude Code, let it start subagents, and nothing else:

```bash
claude --tools "Agent" --strict-mcp-config --mcp-config .mcp.json --allowedTools mcp__clank-talk
```

Subagents get only the tools of the session, so they get ClankTalk too, and nothing else. One catch: a custom subagent that lists `Glob` or `Grep` in its `tools:` gets them anyway, so don't list them.

Each subagent can pass its name as `agent` when it calls ClankTalk. Then it gets its own undo list and its own `$` variables, so one helper can't undo another's work, and the audit says who did what.

### pi

ClankTalk is also a [pi](https://pi.dev) package. It runs inside pi, so `ask` and fetch approvals show up as pi dialogs, and it turns off every other tool for you. No flags to forget. Install it for one project:

```bash
pi install -l git:github.com/bigskysoftware/clank-talk
```

Or try it once, with no install:

```bash
pi -e git:github.com/bigskysoftware/clank-talk
```

Careful with a plain `pi install`, with no `-l`: then every pi session on your machine gets ClankTalk, and only ClankTalk.

## The Language

A quick tour. The [docs for agents](reference.html) have the rest.

### Comments, Blocks and Help

Comments start with `#`. Commands follow one another, no punctuation needed. If you want two on one line, use `then`. Blocks always close with `end`. Always.

```talk
# this is a comment
set x to 1 then print x
if x > 10
  print 'big'
end
```

ClankTalk can explain itself. `help` lists everything, and `help <word>` shows one thing, with examples. This is how an agent learns the language: it asks.

```talk
help
help replace
help tools
```

### Values and Strings

Numbers, text, `true`, `false`, `null`, lists and objects:

```talk
set robot to {name: 'clank', tags: ['agent', 'robot'], parts: 1_000}
```

Single or double quotes, your pick. Strings can span lines, and the indent they all share is removed, so you can indent them with your script. Use `${...}` to put a value in:

```talk
set message to '
  Dear human,
    Your tests passed.
  '
print 'Hello, ${robot's name}!'
```

For code, use a raw string: three double quotes. No escapes, no `${}`, and the indent is kept exactly:

```talk
set code to """
    const greeting = `Hi ${name}`;
"""
```

The line break right after the opening quotes is not part of the text. Want the text to start with a blank line? Leave one empty line after the opening quotes.

Need `"""` in the text? Open with four quotes, and close with four:

```talk
print """"say """hi""" """"
```

### Variables and the Result

```talk
set total to 0
increment total by 5
set $last_total to total
```

A plain name is local to the script. A name that starts with `$` is a global, and sticks around between scripts. Use a name before you set it and you get an error, with a guess if it looks like a typo: `Did you mean 'total'?`. A global that was never set is just `null`. Most commands put their value in `it`, also known as `the result`:

```talk
read @/README.md
print it
```

Printed a lot? Your agent sees the start and the end (up to 1000 lines, or less with `limit output to 400 lines` in `AGENTS.talk`), and a note in the middle. The rest isn't lost. The next script gets all of it as `the previous output`:

```talk
set failures to find 'not ok' in the previous output
```

### Expressions

`the` is optional. Use it where it reads better. There are three ways to get a property, and they all mean the same thing:

```talk
print robot's name
print robot.name
print the name of robot
```

Math works the way you'd expect, with one twist: mixing operators needs parentheses. `1 + 2 * 3` is an error. Nobody should have to remember precedence while reading agent code.

```talk
print 1 + (2 * 3)
if total is greater than 10 and no errors
  print 'ok'
end
```

### Control Flow

```talk
if count > 10
  print 'many'
else if count > 0
  print 'some'
else
  print 'none'
end

for item in [1, 2, 3] index i
  print '${i}: ${item}'
end

repeat until done
  set done to true
end
```

`break` and `continue` work in any loop. And when you need to wait for something:

```talk
wait 2 seconds
```

### Errors

An error stops the script. Unless you catch it:

```talk
read ./missing.txt
print 'this runs too'

on error
  print 'could not read: ' + the error's message
  continue
end
```

`on error` can go anywhere in a script, and covers all of it. `continue` goes on with the command after the one that failed. `stop`, the default, ends the script with the error.

## Files

Paths are part of the language:

* `./notes.txt` and `../notes.txt` start from the current folder
* `@/README.md` starts from the project root
* `./src/**/*.js` gives a list of files. Globs skip `.git` and whatever git ignores, unless you name the folder in the pattern
* `./"my notes.txt"` holds a path with spaces
* `https://example.com/api` is a URL, no quotes needed

Anything outside the project root is refused. A file has a `name`, `path`, `text`, `lines`, `size` and `modified`, and text checks work right on a file:

```talk
for file in @/src/**/*.js
  if file contains 'TODO'
    print file's path
  end
end
```

### Lines and Finding

Each line knows its number, and `first` and `last` work on lists, files and text:

```talk
print lines 10 to 20 of ./notes.txt
print the last of ./notes.txt
```

Need just one? Grab it by number, then use it on the next line:

```talk
set title to line 1 of ./notes.txt
print title's text
```

`find` gives you the lines that contain some text, in one file or many. Each line knows its file, so `print` shows `src/app.js:12: // TODO: fix`:

```talk
find 'TODO' in @/src/**/*.js
print the result
```

`find` is a value too, so you can keep what it finds:

```talk
set todos to find 'TODO' in @/src/**/*.js
print todos's length
```

Need more than plain text? Use a `pattern`. It is a JavaScript regexp:

```talk
set failures to find pattern 'not ok|FAIL' in the result's output
replace pattern """(\w+)@old\.com""" with '$1@new.com' in ./users.txt
if tag matches pattern """^v\d+\.\d+$"""
  print 'a release'
end
```

In `replace`, `$1`, `$<name>` and `$&` put the matched parts back. A pattern that runs wild is stopped after 2 seconds, so one bad regexp can't hang your agent.

Want a tidy list? There's `sorted` and `unique`: `print sorted unique failures`.

### Changing Files

```talk
write 'hello' to ./out.txt
append ' world' to ./out.txt
replace 'retries: 3' with 'retries: 5' in ./src/config.js
move ./out.txt to ./notes/out.txt
```

`move` never writes over a file that is already there. For a file in git, `git move` does the same, and git sees the rename.

You can name the file first, too. That reads well when you change several things in one file:

```talk
in ./src/config.js
  replace 'retries: 3' with 'retries: 5'

in ./src/app.js do
  replace 'var ' with 'let '
  find 'TODO'
  print the result
end
```

`replace` changes every match, and gives back a list of what it changed. If nothing matched, you get a warning, since that is usually a typo.

You can also edit by line number. Read the file first, so you know the numbers:

```talk
print lines 10 to 12 of ./src/app.js
replace lines 11 to 11 of ./src/app.js with 'let x = 2'
put '// added' after line 12 of ./src/app.js
remove lines 20 to 22 of ./src/app.js
```

That is a lot of `of ./src/app.js`. In an `in ... do` block, you can leave it off:

```talk
in ./src/app.js do
  read
  print lines 10 to 12
  replace lines 11 to 11 with 'let x = 2'
  put '// added' after line 12
end
```

You and your agent can work on the same files. If you save a file after the agent read it, the agent's next write fails, and it has to read the file again. Your change stays.

## Tools

Sometimes your agent really does need to run something, like your test suite. Fine! You define tools in `AGENTS.talk`, and the comment above a tool is its help:

```talk
# AGENTS.talk
allow env PATH, HOME

# Runs the full test suite.
tool run_tests
  run 'npm test' in a sandbox with local network within 10 minutes
end

# Runs one test file.
tool run_test with file
  run 'node' with '--test', file in a sandbox
end
```

Your agent calls tools by name:

```talk
run_tests within 5 minutes
print the result's code

run_test with file: './test/app.test.js'
```

A call is a value too, so you can give its answer a name. Then the next command can't wipe it out:

```talk
set tests to run_tests within 5 minutes
if tests's code is not 0
  set failures to find 'FAIL' in tests's output
  print failures
end
```

`run` only works inside a tool, never uses a shell, and passes on only the environment variables that `allow env` lists. Got a set of tools you like? Put them in their own `.talk` file, and `import ./talk/git.talk`.

### Sandboxes

Your agent can write code, and `npm test` runs code. So a tool that runs your tests can, in effect, run anything your agent writes. That's why the tools above say `in a sandbox`.

In a sandbox, a program can write only your project (but not `.git`, `.talk` files or hidden files), read only system folders, its own install folder and tool caches, and has no network. Its home folder is a fresh, empty one, so it can't read your secrets. Loosen it where a tool needs it:

```talk
# AGENTS.talk
tool install
  run 'npm install' in a sandbox with network, writes to '~/.npm'
end
```

The options are `with network`, `with local network` (localhost only, for tests that start their own servers), `writes to <path>` and `reads of <path>`.

It works on macOS (`sandbox-exec`) and Linux (`bubblewrap`). Anywhere else, a sandboxed `run` is an error. It never quietly runs without the sandbox. Before the first sandboxed run, ClankTalk tests that the sandbox really holds.

On Ubuntu 23.10 and later, AppArmor can block the user namespaces that `bubblewrap` needs, and the self-test fails with a `bwrap:` error. Ask your admin to allow them for `bwrap`, with an AppArmor profile, or for the whole machine:

```bash
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

### Servers

A tool can also start something that keeps running, like a dev server:

```talk
# AGENTS.talk
tool site_server
  start 'npm run serve-site' as 'site' in a sandbox
end
```

Your agent can then wait for it, look at it, and stop it. When the session ends, ClankTalk stops them all.

```talk
site_server
wait until (fetch http://localhost:8000/ as response)'s status is 200 within 10 seconds
print the output of process 'site'
stop process 'site'
```

## Safety

Here is what ClankTalk won't let your agent do, and how you can let it, when you want to.

### Files It Can't Change

Scripts can't change `.talk` files, so your agent can't change its own tools. They can't change hidden files or folders either, like `.env`, `.git/` or `.github/`: those hold secrets, and config that runs code. Nothing is allowed by default. If your agent needs one, it tells you the line to add:

```talk
# AGENTS.talk
allow changes to @/.github/, @/.gitignore
```

And `.env` files are off limits all the way: a script can't even read them, in any folder. Your secrets stay out of the agent's context.

### Git

ClankTalk has git built in, with the dangerous parts taken out:

```talk
git status
git diff ./src/app.js
git switch to new branch 'fix-parser'
git commit [./src/app.js, ./test/app.test.js] with 'Fix the parser'
git switch to 'main'
git merge 'fix-parser'
git delete branch 'fix-parser'
```

`git commit` commits only the files you name, so your agent can't sweep in something you didn't expect. `git merge` only fast-forwards. Branch fell behind? `git rebase onto 'main'` moves it up to date, or, on a conflict, leaves it just as it was. `git push` sends the current branch to `origin`, and never with force.

Git can run programs from its config: hooks, pagers, filters, and more. So ClankTalk turns all of those off, and starts git with a clean environment. If the repo's own config still asks git to run a program, git won't run at all, and your agent tells you what to remove.

### Fetch

```talk
fetch https://api.github.com/repos/bigskysoftware/htmx as json
print it's stargazers_count
```

A fetch can send your project's data anywhere, so the first fetch to a new host asks you. Say yes, and that host is fine for the rest of the session. Hosts you always trust go in `AGENTS.talk`. `localhost` and private addresses must be listed there too, so a script can't poke at your local services or your cloud's metadata server by accident:

```talk
# AGENTS.talk
allow fetch from 'api.github.com', '*.npmjs.org', 'localhost'
```

### Asking You

`ask` puts a question to you, and waits, two minutes at most, unless you say `within`. Only you answer, never the agent. If nobody answers, it gives `null`, which means no:

```talk
ask 'Delete the old logs?' with 'yes' or 'no' within 5 minutes
if the result is 'yes'
  print 'ok'
end
```

### Hooks

Security policy should be code you can read. Hooks go in `AGENTS.talk`, and run before or after a step. A `before` hook can `reject` the step: it doesn't happen, and the script gets an error.

```talk
# AGENTS.talk
before run
  if the run's sandbox is null
    reject 'Use a sandbox'
  end
end

before git
  if the git's operation is 'commit'
    ask 'Commit ' + the git's files + '?' with 'yes' or 'no'
    if the result is not 'yes'
      reject 'The human said no'
    end
  end
end
```

A hook can watch `read`, `write`, `append`, `replace`, `put`, `remove`, `undo`, `run`, `start`, `stop`, `git`, `fetch`, any tool by name, or `change`, which is any file change. `the <step>` holds the details, like `the write's path`. Commands inside a hook don't run hooks, so a hook can't trip over itself.

### Audit

Ever wonder what your agent is actually doing? Every step that touches the world is written to `talk/audit/`, one file a day:

```text
== 10:42:01  script 12  done  6 steps ==
  in @/src/config.js
    replace 'retries: 3' with 'retries: 5'
  run_tests
--
10:42:01  replace  src/config.js                             undo saved
10:42:01  tool     run_tests
10:42:09  run      npm test                                  in a sandbox with local network, code 0, 7.9 s, from run_tests
```

Your agent can't change it: scripts can't touch `talk/`. Want it for tools instead of eyes? Add `audit as json` to `AGENTS.talk`. And your agent can read its own: `the audit` holds this session's steps, so you can ask it what it did.

One tip: the audit is a log, not source. Keep it out of git with one line in your `.gitignore`:

```text
talk/audit/
```

### Undo

Your agent made a mess? Take it back:

```talk
undo                          # the last script that changed files
undo 3                        # the last three
undo changes to ./src/app.js  # just one file
print the undo list
```

Undo works across scripts in the same session. If a file changed after the script, say you edited it yourself, undo won't touch anything. Undo covers file changes only: not programs that `run` started, and not git commits.

## The Fine Print

Be honest with yourself about a few things:

* A `run` without `in a sandbox` is where the ClankTalk sandbox ends. The program can do anything you can do.
* The sandbox limits files and the network. It doesn't limit CPU or memory.
* On Linux, the sandbox is weaker: it protects hidden files only at the top of your project, and only the ones that exist when the program starts. We test on macOS. If you use Linux, please test it, and tell us.
* A web page or a tool's output can hold text that tries to steer your agent. ClankTalk keeps the damage small, but it can't stop your agent from believing what it reads.

</div>
