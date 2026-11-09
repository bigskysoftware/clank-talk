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
