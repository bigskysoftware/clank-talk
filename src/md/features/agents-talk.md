# AGENTS.talk

The user writes an AGENTS.talk file to expose tools to the agent.
Example: a tool that runs one maven task.

## Trust

- AGENTS.talk is user code. It is trusted.
- AGENTS.talk can use privileged capabilities, for example a fixed command run.
- The agent can call the tools that AGENTS.talk defines. The agent cannot change AGENTS.talk.

## Open questions

- Privileged primitives available only in AGENTS.talk: TODO
- How the runtime prevents agent writes to AGENTS.talk: TODO
- Tool description format for the agent: TODO

## Security of `run`

### Decisions

- `run` takes a program and a list of arguments. It never uses a shell.
- `run 'mvn test'` splits one string on spaces into a program and its arguments. No shell features (quotes, pipes, `$`).
- Implementation: Node `child_process.spawn` or `execFile` with an argument array and no `shell` option. Never `exec`.
- The child process starts with an empty environment, plus a list of allowed variables.
- Before `run`, the runtime asks the human if the agent changed files since the last approval. Taint tracks the changes.
- An OS sandbox for `run` comes later, as a plugin.
- `run` is where the ClankTalk sandbox ends. Document this for users.
- Open: refuse argument values that start with `-`, and typed parameters.

### Analysis

Arguments to a tool come from the agent. Treat them as untrusted.

### Risks

1. Shell injection: if `run` passes one string to a shell, `name` = `x; rm -rf ~` runs a second command.
2. Argument injection: with no shell, a value that starts with `-` can still change the program, for example `-f other-pom.xml` or `--settings evil.xml`.
3. Project code: `mvn test`, `npm test` and build tools run code from the project. The agent can write that code. Thus any tool that runs project code gives the agent full code execution with user rights. This is true even with fixed arguments.
4. Program path: `./mvnw` and `node_modules/.bin` are in the project, so the agent can change them. `PATH` can also find agent-written files.
5. Environment: a child process gets the user's environment, with secrets in it.
6. Output: command output can hold secrets or prompt injection.

### Mitigations

- `run` takes a program and a list of arguments, and never uses a shell. (Risk 1)
- Typed or checked parameters. The runtime refuses values that start with `-`, unless the tool allows them. Put `--` before user values where the program supports it. (Risk 2)
- An OS sandbox for `run`: no network, writes only inside the project, no access to home. macOS `sandbox-exec`, Linux `bubblewrap` or Landlock, or a container. This is the only real fix for risk 3.
- Optional: ask the human before `run` if the agent changed files since the last approval. Taint can track this. (Risk 3)
- Resolve the program to an absolute path when AGENTS.talk loads. Warn when the program is inside the project. (Risk 4)
- Start the child with an empty environment plus a list of allowed variables. Secrets go in by name only. See [secrets.md](secrets.md). (Risk 5)
- Time limit and output size limit. Output is tainted. (Risk 6)
- The audit log records the full program and argument list.
