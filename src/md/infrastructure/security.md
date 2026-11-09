# Security

All security decisions in one place. Each decision links to its feature.

## Deferred

Decisions that we put off. Each one needs a human decision later.

- Argument values from the agent are not checked. Later: refuse values that start with `-`, or typed parameters. See `run` below.
- OS sandbox for `run` (later, as a plugin). See `run` below.
- Ask the human before `run` when the agent changed files since the last approval. Deferred.
- Resolve the `run` program to an absolute path when AGENTS.talk loads, and warn when it is inside the project. Deferred.
- `.js` plugins in the protected `@/talk/` folder. Open. Scripts cannot write the folder, but programs that `run` starts can.

## Values

Feature: [../features/runtime.md](../features/runtime.md).

- Property access sees only own data properties. `constructor`, `__proto__`, `prototype` and functions give `null`.
- Object literals have no prototype, so a field named `__proto__` is only a field.
- `set` makes a plain own field with `Object.defineProperty`, so `set x's __proto__ to ...` cannot change a prototype.
- Each command is one step, and each loop pass is one step. The step budget stops scripts that do not end, even an empty `repeat while true end`.

## Files

Feature: [../features/runtime.md](../features/runtime.md).

- Every path is checked against the project root, before symlinks (`path.resolve`) and after them (`fs.realpath`). A path or symlink that goes outside the root is an error.
- Glob results are checked one by one.
- File objects cannot be changed with `set`, and index access cannot see their inside fields.
- Writes use the same checks. For a new file, the nearest folder that exists must be inside the root after symlinks, before any folder is made. Thus a symlinked folder cannot lead a new file outside the root.

## .talk files and the talk folder

Feature: [../features/agents-talk.md](../features/agents-talk.md).

- A script cannot write, append to or replace in any `.talk` file, or anything in `@/talk/`, or make them. Thus an agent cannot change its own tools.
- Scripts can read them.
- The check uses the path as written and the path after symlinks, in any letter case. For AGENTS.talk it also compares the file on disk (device and inode), so a hard link to it is refused too.
- Limit: a hard link with another name to another `.talk` file is not caught. Only the user or a `run` program can make one.
- Limit: a program that `run` starts can still change these files. Only an OS sandbox closes this.

## `run`

Feature: [../features/agents-talk.md](../features/agents-talk.md).

### Decisions

- `run` takes a program and a list of arguments. It never uses a shell.
- `run 'mvn test'` splits one string on spaces into a program and its arguments. No shell features (quotes, pipes, `$`).
- Implementation: Node `child_process.spawn` or `execFile` with an argument array and no `shell` option. Never `exec`.
- The child process starts with an empty environment, plus the variables that `allow env` in AGENTS.talk lists.
- `run` is only allowed in tools, never in scripts.
- Deferred: before `run`, the runtime asks the human if the agent changed files since the last approval. Taint tracks the changes.
- An OS sandbox for `run` comes later, as a plugin.
- `run` is where the ClankTalk sandbox ends. Document this for users.
- For now, the runtime does not check argument values. The tool author must guard against argument injection, for example an agent value `--rulesdir=./evil` passed to `eslint`. Later: refuse values that start with `-`, or typed parameters (`with file as path`).

### Analysis

Arguments to a tool come from the agent. Treat them as untrusted.

#### Risks

1. Shell injection: if `run` passes one string to a shell, `name` = `x; rm -rf ~` runs a second command.
2. Argument injection: with no shell, a value that starts with `-` can still change the program, for example `-f other-pom.xml` or `--settings evil.xml`.
3. Project code: `mvn test`, `npm test` and build tools run code from the project. The agent can write that code. Thus any tool that runs project code gives the agent full code execution with user rights. This is true even with fixed arguments.
4. Program path: `./mvnw` and `node_modules/.bin` are in the project, so the agent can change them. `PATH` can also find agent-written files.
5. Environment: a child process gets the user's environment, with secrets in it.
6. Output: command output can hold secrets or prompt injection.

#### Mitigations

- `run` takes a program and a list of arguments, and never uses a shell. (Risk 1)
- Typed or checked parameters. The runtime refuses values that start with `-`, unless the tool allows them. Put `--` before user values where the program supports it. (Risk 2)
- An OS sandbox for `run`: no network, writes only inside the project, no access to home. macOS `sandbox-exec`, Linux `bubblewrap` or Landlock, or a container. This is the only real fix for risk 3.
- Optional: ask the human before `run` if the agent changed files since the last approval. Taint can track this. (Risk 3)
- Resolve the program to an absolute path when AGENTS.talk loads. Warn when the program is inside the project. (Risk 4)
- Start the child with an empty environment plus a list of allowed variables. Secrets go in by name only. See [../features/secrets.md](../features/secrets.md). (Risk 5)
- Time limit and output size limit. Output is tainted. (Risk 6)
- The audit log records the full program and argument list.
