# AGENTS.ct

The user writes an AGENTS.ct file to expose tools to the agent.
Example: a tool that runs one maven task.

## Trust

- AGENTS.ct is user code. It is trusted.
- AGENTS.ct can use privileged capabilities, for example a fixed command run.
- The agent can call the tools that AGENTS.ct defines. The agent cannot change AGENTS.ct.

## Open questions

- Privileged primitives available only in AGENTS.ct: TODO
- How the runtime prevents agent writes to AGENTS.ct: TODO
- Tool description format for the agent: TODO
