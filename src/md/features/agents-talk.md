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

## Decisions

Approved:

- The runtime reads `@/AGENTS.talk` at the start of each run, if it exists. Changes take effect at once.
- A script cannot `write`, `append` or `replace` in any `.talk` file or in `@/talk/`. A script can read them. See security.md.
- `AGENTS.talk` holds only definitions at the top level: `tool` now, `before` and `after` later. Any other command there is an error.
- Parameters are separated by commas: `tool deploy with env, version`.
- Calls by position, with commas (`deploy 'prod', '1.2'`), or by name (`deploy with env: 'prod', version: '1.2'`). A missing argument is `null`. An unknown name, or too many arguments, is an error.
- A tool body has its own local variables. Parameters are local variables. `$` globals are shared. A tool can call other tools, on the same step budget.
- A call gives back the tool's `the result` at the end of the tool: whatever the last command put there. There is no `return`.
- Host tools (`options.tools`) still work. A name in both places is an error.
- Errors in `AGENTS.talk` say which file they come from.
- AGENTS.talk is parsed two times. The first pass finds the tool names, so one tool can call another.
- A tool name ends the argument list, so `bump bump` is two calls.
- Approved: `set the result to ...` (and `set it to ...`) sets the result. A tool uses this to give back a value.

- The agent gets a built-in way to list its tools (names, parameters, descriptions), so it does not need to parse AGENTS.talk. Open: the syntax. This goes with [discoverability.md](discoverability.md).

## Import

- Approved: `import <path>` loads tools and more commands. Local paths only, for now.
- Approved: `.talk` files only. `.js` plugins would run with the user's full rights, an injection risk.
- Open: only in `AGENTS.talk`?
- Approved: the `@/talk/` folder is protected from script writes.
- Open: `.js` plugins in `@/talk/`.

## Security

See [../infrastructure/security.md](../infrastructure/security.md).

## Hooks (plan)

- Inside `before <command>` and `after <command>`, a local variable with the name of the command holds that step. Refer to it with `the`: `the write's path`, `the fetch's url`, `the run_tests's code`.
- Each command declares the fields of its step. List them in src/md, so discoverability can show them.
- `after` hooks also get `the result`.
