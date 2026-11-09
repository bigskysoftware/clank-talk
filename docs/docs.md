<div class="features">

<p><a href="./">Home</a></p>

# ClankTalk Docs

## Introduction

ClankTalk is a scripting language for AI agents. You give your agent ClankTalk, in place of a shell.

Here is a script an agent might write:

```talk
for file in ./src/**/*.js
  if the file's text contains 'var '
    replace 'var ' with 'let ' in the file
  end
end
```

The first thing you probably noticed is that it reads like English. ClankTalk is a member of the [xTalk](https://en.wikipedia.org/wiki/XTalk) family, like HyperTalk and [hyperscript](https://hyperscript.org). That's on purpose: the agent writes the script, but *you* have to read it.

The second thing you might notice is what's missing: no shell, no pipes, no `rm -rf`. The runtime is the sandbox. If ClankTalk can't do it, your agent can't do it.

<div class="construction">

ClankTalk is under construction. Expect things to change.

</div>

## Getting Started

ClankTalk runs as an [MCP](https://modelcontextprotocol.io) server with one tool, `clank_talk`. Point your agent at it with a `.mcp.json` in your project:

```json
{
  "mcpServers": {
    "clank-talk": {
      "command": "node",
      "args": ["bin/clank-talk-mcp.js", "--log", "tmp/clank-talk.log"]
    }
  }
}
```

Then take away the agent's other tools. With Claude Code:

```bash
claude --tools "" --strict-mcp-config --mcp-config .mcp.json
```

Want to see what your agent is up to? Watch the log:

```bash
tail -f tmp/clank-talk.log
```

TODO: npm package.

## Language Basics

### Comments

Comments start with `#` and go to the end of the line:

```talk
# this is a comment
print 'Yep, that was a comment' # and so is this
```

### Separators

Commands follow one another, no punctuation needed. If you want two commands on one line, use `then`:

```talk
set x to 1 then print x
```

Blocks always close with `end`. Always.

```talk
if x > 10
  print 'big'
end
```

### Help

ClankTalk can explain itself. `help` lists everything, and `help <word>` shows one thing, with examples:

```talk
help
help replace
help tools
```

This is how an agent learns the language: it asks.

## Values

Numbers, text, `true`, `false`, `null`, lists and objects:

```talk
set robot to {name: 'clank', tags: ['agent', 'robot'], parts: 1_000}
```

### Strings

Single or double quotes, your pick. Strings can span lines, and the indent they all share is removed, so you can indent them with your script:

```talk
set message to '
  Dear human,
    Your tests passed.
  '
```

Use `${...}` to put a value into a string:

```talk
print 'Hello, ${robot's name}!'
```

For code, use a raw string: three double quotes. No escapes, no `${}`, and the indent is kept exactly:

```talk
set code to """
    const greeting = `Hi ${name}`;
"""
```

## Variables

```talk
set total to 0
increment total by 5
decrement total
set $last_total to total
```

A plain name is local to the script. A name that starts with `$` is a global, and sticks around between scripts.

Most commands put their value in `it`, also known as `the result`:

```talk
read @/README.md
print it
```

## Expressions

`the` is optional. Use it where it reads better:

```talk
print the result
```

There are three ways to get a property, and they all mean the same thing:

```talk
print robot's name
print robot.name
print the name of robot
```

Math works the way you'd expect, with one twist: mixing operators needs parentheses. `1 + 2 * 3` is an error. Nobody should have to remember precedence while reading agent code.

```talk
print 1 + (2 * 3)
```

Comparisons come in words and symbols:

```talk
if total is greater than 10 and no errors
  print 'ok'
end
```

Text checks: `contains`, `starts with`, `ends with`, `is in`, `is empty`, `exists`, and their `not` forms. Conversions: `as json`, `as pretty json`, `as number`, `as text`.

```talk
set config to the file's text as json
```

## Control Flow

```talk
if count > 10
  print 'many'
else if count > 0
  print 'some'
else
  print 'none'
end
```

Loops:

```talk
for item in [1, 2, 3] index i
  print '${i}: ${item}'
end

repeat 3 times
  print 'clank'
end

repeat until done
  set done to true
end
```

`break` and `continue` work in any loop.

## Files

Paths are part of the language:

* `./notes.txt` and `../notes.txt` start from the current folder
* `@/README.md` starts from the project root
* `./src/**/*.js` gives a list of files. Globs skip `node_modules` and `.git`, unless you name them in the pattern
* `./"my notes.txt"` holds a path with spaces

Anything outside the project root is refused.

A file has a `name`, `path`, `text`, `lines`, `size` and `modified`. Text checks work right on a file:

```talk
for file in @/src/**/*.js
  if file contains 'TODO'
    print file's path
  end
end
```

### Lines

Each line knows its number:

```talk
for line in lines of ./notes.txt
  if line contains 'TODO'
    print line
  end
end

print lines 10 to 20 of ./notes.txt
print the last of ./notes.txt
```

`first` and `last` work on lists, files and text.

### Finding

`find` gives you the lines that contain some text, in one file or many:

```talk
find 'TODO' in @/src/**/*.js
print the result
```

Each line knows its file and its number, so `print` shows `src/app.js:12: // TODO: fix`. `find` also works on text, such as the output of a tool:

```talk
run_tests
find 'FAIL' in the result's output
if the result is empty
  print 'all good'
end
```

### Changing Files

```talk
write 'hello' to ./out.txt
append ' world' to ./out.txt
replace 'var ' with 'let ' in ./src/app.js
```

`replace` changes every match, and gives back a list of what it changed. If nothing matched, the result is empty, and you get a warning, since that is usually a typo.

You can also edit by line number. Read the file first, so you know the numbers:

```talk
print lines 10 to 12 of ./src/app.js
replace lines 11 to 11 of ./src/app.js with 'let x = 2'
put '// added' after line 12 of ./src/app.js
remove lines 20 to 22 of ./src/app.js
```

### Working Together

You and your agent can work on the same files. If you save a file after the agent read it, the agent's next write fails, and it has to read the file again. Your change stays.

### Undo

Your agent made a mess? Take it back:

```talk
undo                          # the last script that changed files
undo 3                        # the last three
undo changes to ./src/app.js  # just one file
print the undo list
```

Undo works across scripts in the same session. If a file changed after the script, say you edited it yourself, undo won't touch anything. Undo covers file changes only: not programs that `run` started, and not git commits.

## Errors

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

## Git

ClankTalk has git built in, with the dangerous parts taken out:

```talk
git status
print it

git diff ./src/app.js
git log 5
git show 'HEAD'
git branch

git switch to new branch 'fix-parser'
git commit [./src/app.js, ./test/app.test.js] with 'Fix the parser'
git switch to 'main'
git merge 'fix-parser'
git delete branch 'fix-parser'
```

`git commit` adds and commits only the files you name, so your agent can't sweep in something you didn't expect. `git merge` only fast-forwards, so it never makes a merge commit or a conflict. `git push` sends the current branch to origin, but asks you first, every time. If you trust your agent with that, add `allow git push` to `AGENTS.talk`.

Git can run programs from its config: hooks, pagers, filters, and more. So ClankTalk turns all of those off, and starts git with a clean environment. If the repo's own config still asks git to run a program, git won't run at all, and your agent tells you what to remove.

## Tools

Sometimes your agent really does need to run something, like your test suite. Fine!

You define tools in `AGENTS.talk`, at the root of your project:

```talk
# AGENTS.talk
allow env PATH, HOME

# Runs the full test suite.
tool run_tests
  run 'npm test' within 10 minutes
end

# Runs one test file.
tool run_test with file
  run 'node' with '--test', file
end
```

Got a set of tools you like? Put them in their own `.talk` file, and import it:

```talk
# AGENTS.talk
import ./talk/git.talk
```

The comment above a tool is its help. Your agent calls tools by name:

```talk
run_tests within 5 minutes
if the result's code is not 0
  print the result's output
end

run_test './test/app.test.js'
run_test with file: './test/app.test.js'
```

A few rules keep this safe:

* `run` only works inside a tool, and never uses a shell
* The program gets only the environment variables that `allow env` lists
* Scripts can't change `.talk` files, so your agent can't change its own tools
* Scripts can't change hidden files or folders, like `.env`, `.git/` or `.github/`. Those hold secrets, and config that runs code. Nothing is allowed by default. If your agent needs one, it tells you the line to add:

```talk
# AGENTS.talk
allow changes to @/.github/, @/.gitignore
```

## Hooks

Security policy should be code you can read. Hooks go in `AGENTS.talk`, and run before or after a step:

```talk
# AGENTS.talk
before change
  if the change's path ends with '.env'
    reject 'Cannot change env files!'
  end
end

after run
  print 'ran ' + the run's program + ': ' + the result's code
end
```

A hook can watch `read`, `write`, `append`, `replace`, `put`, `remove`, `undo`, `run`, `git`, any tool by name, or `change`, which is any file change. `the <step>` holds the details, like `the write's path`. A `before` hook can `reject` the step: it doesn't happen, and the script gets an error.

Hooks run for the agent's scripts and inside tools. Commands inside a hook don't run hooks, so a hook can't trip over itself.
A hook can ask you before a step happens. Only you answer, never the agent:

```talk
# AGENTS.talk
before git
  if the git's operation is 'commit'
    ask 'Commit ' + the git's files + '?' with 'yes' or 'no'
    if the result is not 'yes'
      reject 'The human said no'
    end
  end
end
```

If nobody can answer, `ask` gives `null`, and the hook above says no. Safe by default.

## The Fine Print

Be honest with yourself about one thing: if a tool runs project code, like a test suite, the agent can write that code. `run` is where the ClankTalk sandbox ends.

</div>
