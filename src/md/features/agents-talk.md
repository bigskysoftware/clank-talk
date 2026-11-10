# AGENTS.talk

The user writes an AGENTS.talk file to expose tools to the agent.
Example: a tool that runs one maven task.

## Trust

- AGENTS.talk is user code. It is trusted.
- AGENTS.talk can use privileged capabilities, for example a fixed command run.
- The agent can call the tools that AGENTS.talk defines. The agent cannot change AGENTS.talk.

## Answered questions

- Only in AGENTS.talk and its imports: `tool`, `run`, `start`, `import`, `before`, `after`, `reject`, and the `allow` lines (only in AGENTS.talk itself). See `help`.
- Agent writes to `.talk` files are refused. See [../infrastructure/security.md](../infrastructure/security.md).
- The tool description is the `#` comment lines above a `tool`. See [discoverability.md](discoverability.md).

## Decisions

Approved:

- The runtime reads `@/AGENTS.talk` at the start of each run, if it exists. Changes take effect at once.
- A script cannot `write`, `append` or `replace` in any `.talk` file or in `@/talk/`. A script can read them. See security.md.
- `AGENTS.talk` holds only definitions at the top level: `tool`, `before`, `after`, `import` and the `allow` lines. Any other command there is an error.
- Parameters are separated by commas: `tool deploy with env, version`.
- Calls by position, with commas (`deploy 'prod', '1.2'`), or by name (`deploy with env: 'prod', version: '1.2'`). A missing argument is `null`. An unknown name, or too many arguments, is an error.
- A tool body has its own local variables. Parameters are local variables. `$` globals are shared. A tool can call other tools, on the same step budget.
- A call gives back the tool's `the result` at the end of the tool: whatever the last command put there. There is no `return`.
- Host tools (`options.tools`) still work. A name in both places is an error.
- Errors in `AGENTS.talk` say which file they come from.
- AGENTS.talk is parsed two times. The first pass finds the tool names, so one tool can call another.
- A tool name ends the argument list, so `bump bump` is two calls.
- Approved: `set the result to ...` (and `set it to ...`) sets the result. A tool uses this to give back a value.

- Built: `help tools` lists the tools (names, parameters, descriptions), so the agent does not need to parse AGENTS.talk. The MCP tool description lists them too. See [discoverability.md](discoverability.md).

## run

Approved:

- `run` is allowed in every tool, in AGENTS.talk and in imported `.talk` files. It is not allowed in scripts.
- `run 'mvn test'` splits one string on spaces. `run 'mvn' with 'test', '-Dtest=x'` passes each argument as it is.
- `allow env PATH, HOME, JAVA_HOME` at the top level of AGENTS.talk lists the environment variables that `run` passes on, with the user's values. All others are left out.
- No time limit by default. `run ... within 10 minutes` sets one in a tool. `run_tests within 5 minutes` sets one on a call, for any tool. When both are set, the shorter one wins.
- Durations as in hyperscript: `100ms`, `2s`, `5 seconds`, `10 minutes`, `1 hour`.
- `run` gives back `{ code, output }`. `output` is stdout and stderr together, in the order they came. A non-zero code is not an error: check `the result's code`.
- Approved (built): an argument from a variable or a parameter must not start with `-`, unless a written-out `'--'` comes before it. A program found through `PATH` inside the project is an error. See [../infrastructure/security.md](../infrastructure/security.md).
- `run` uses the current directory (`cwd`). A missing program is an error. A program that goes over its time limit is stopped, and that is an error. Cancel stops the program too.
- Later (its own branch): `execution.running`, `execution.pause()` and `execution.resume()`, so the agent can pause a run and look at its output so far.

## Import

- Approved: `import <path>` loads tools from another `.talk` file. Local paths inside the project only, for now.
- Approved: `import` works in AGENTS.talk and in the files it imports. Scripts cannot import.
- Approved: `./` and `../` start from the importing file. `@/` starts from the project root.
- Approved: `allow env` is only allowed in AGENTS.talk, so the list of environment variables stays in one file.
- Approved: `allow changes to <path>, ...` at the top level of AGENTS.talk lists hidden files and folders that scripts can change. Only AGENTS.talk can have it. See [../infrastructure/security.md](../infrastructure/security.md).
- An import loop is an error. A file imported two times loads once. Errors in an imported file name that file. Tools from all files can call each other.
- Approved: `.talk` files only. `.js` plugins would run with the user's full rights, an injection risk.
- Approved: the `@/talk/` folder is protected from script writes.
- Open: `.js` plugins in `@/talk/`.

## Security

See [../infrastructure/security.md](../infrastructure/security.md).

## Hooks

See [hooks.md](hooks.md).

