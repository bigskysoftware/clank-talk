# Examples

Real agent tasks, written in ClankTalk. These examples drive the syntax design.

Decisions from these examples are in [language.md](language.md). Lines marked "Open" still need a human decision.

## 1. Read a file, ask the user

```talk
read @/README.md
print it
```

```talk
set readme to read @/README.md
```

```talk
ask 'What test do you want to run?'
run_test the result
```

- `read` puts the text in `it` and `the result`. `read` is also an expression.
- `print` is the output to the agent.
- `ask` is for the human. The answer goes in `the result`.
- `ask` waits for the user, and can time out.

## 2. Write and append

```talk
write 'hello' to ./out.txt
append ' world' to ./out.txt
```

## 3. Replace text in many files (the site hero)

```talk
for file in ./src/**/*.js
  if the file's text contains 'var '
    replace 'var ' with 'let ' in the file
  end
end
```

- When the target of `replace` is a file, `replace` changes the file itself.

## 4. Change a JSON file (the site "Easy To Read" example)

```talk
for file in ./config/*.json
  set config to the file's text as json
  if config's version is less than 2
    set config's version to 2
    write config as json to the file
  end
end
```

- `as json` parses text to an object, and formats an object to text.

## 5. Search for text

```talk
for file in @/src/**/*.js
  for line in the file's lines
    if line contains 'TODO'
      print `${the file's path}:${line.number}: ${line}`
    end
  end
end
```

- Template strings use `${...}` only.
- A line knows its line number. As text, it is the content of the line.
- `line.number` and `line's number` are the same.

## 6. List a directory

```talk
for file in ./docs/*
  print the file's name
end
```

- A file gives `name`, `path`, `text`, `lines`, `size` and `modified`.

## 7. Fetch JSON

```talk
fetch https://api.example.com/items as json
for item in the result
  print item's name
end
```

- A URL is a token. It starts with `<word>://`. Otherwise it follows the path rules.

## 8. Variables and math

```talk
set total to 0
for item in the result
  increment total by item's price
end
print total
```

```talk
set $last_build to the result
```

- Variables without a prefix are local to the script or feature.
- `$` variables are global and stay for the session.

## 9. Handle a failure

```talk
read ./missing.txt
print it

on error
  print `could not read: ${error's message}`
  continue
end
```

- An `on error` block can go anywhere in a script or feature.
- An `on error` block can end with `stop` or `continue`.
- `on error` covers the whole current feature or script.
- If the block has no `stop` or `continue`, the default is `stop`.
- `continue` goes on with the line after the one that failed.

## 10. Call a tool from AGENTS.talk

```talk
run_tests
if the result's code is not 0
  print the result's output
end
```

```talk
run_test 'UserTest'
run_test with name: 'UserTest'
```

- An unknown word at the start of a statement is a tool call.
- A tool gives back `code` and `output`.
- Tool arguments can be by position or by name.
- Named arguments are separated by commas: `with name: 'A', mode: 'fast'`.

## 11. Define a tool in AGENTS.talk (written by the user)

```talk
tool run_tests
  run 'mvn test'
end
```

```talk
tool run_test with name
  run 'mvn' with 'test', '-Dtest=' + name
end
```

- `run` takes a program and a list of arguments, and never uses a shell. See [agents-talk.md](agents-talk.md).
- `run 'mvn test'` splits one string on spaces into a program and its arguments. This is safe because AGENTS.talk is trusted. Arguments from the agent go in with `with`.

## 12. A hook in AGENTS.talk (written by the user)

```talk
before write
  if the write's path ends with '.env'
    reject 'Cannot update env files!'
  end
end
```

- Hooks can watch `read`, `write`, `fetch`, `run` and tool calls. Language extensions can add more.
- An `after` hook sees what the step gives in `the result`.
