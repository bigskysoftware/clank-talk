# Security

All security decisions in one place. Each decision links to its feature.

## Deferred

Decisions that we put off. Each one needs a human decision later.

- Argument values from the agent are not checked. Later: refuse values that start with `-`, or typed parameters. See `run` below.
- OS sandbox for `run` (later, as a plugin). See `run` below.

## Values

Feature: [../features/runtime.md](../features/runtime.md).

- Property access sees only own data properties. `constructor`, `__proto__`, `prototype` and functions give `null`.
- Object literals have no prototype, so a field named `__proto__` is only a field.
- Each command is one step. The step budget stops scripts that do not end.

## `run`

Feature: [../features/agents-talk.md](../features/agents-talk.md).

### Decisions

- `run` takes a program and a list of arguments. It never uses a shell.
- `run 'mvn test'` splits one string on spaces into a program and its arguments. No shell features (quotes, pipes, `$`).
- Implementation: Node `child_process.spawn` or `execFile` with an argument array and no `shell` option. Never `exec`.
- The child process starts with an empty environment, plus a list of allowed variables.
- Before `run`, the runtime asks the human if the agent changed files since the last approval. Taint tracks the changes.
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
