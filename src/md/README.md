# clank-talk

clank-talk is a scripting language for AI agents. Agents use it in place of bash.
The language runtime is the sandbox. The agent gets only the capabilities that the runtime gives.

Syntax ideas come from https://hyperscript.org. The parser and runtime are new code.

## Goals

- Scripts are easy for humans to read.
- The runtime records a full audit of agent actions.
- The runtime tracks taint on values.
- The runtime supports undo for as many actions as is practical.
- Users add tools and syntax with plugins and AGENTS.talk files.

## Non-goals

- General process execution.
- TODO

## Subtleties

- TODO

## File Index

- [features/language.md](features/language.md): syntax, what to keep from hyperscript
- [features/runtime.md](features/runtime.md): how scripts run, value rules
- [features/examples.md](features/examples.md): real agent tasks in proposed syntax, for review
- [features/sandbox.md](features/sandbox.md): isolation model, in-process runtime
- [features/core-tools.md](features/core-tools.md): built-in fs and fetch
- [features/plugins.md](features/plugins.md): explicit imports for syntax and tools
- [features/discoverability.md](features/discoverability.md): list all syntax, introspect each piece with examples
- [features/agents-talk.md](features/agents-talk.md): user-defined tools in AGENTS.talk
- [features/audit.md](features/audit.md): per-step action log
- [features/taint.md](features/taint.md): value provenance and sink checks
- [features/secrets.md](features/secrets.md): use secrets without seeing them
- [features/undo.md](features/undo.md): per-step undo stack
- [features/hooks.md](features/hooks.md): user policy and security hooks
- [features/git.md](features/git.md): a hardened, built-in git
- [features/ask.md](features/ask.md): ask the human, for approvals
- [features/fetch.md](features/fetch.md): HTTP, with allowed hosts
- [features/background.md](features/background.md): background processes, and wait
- [features/sandbox-run.md](features/sandbox-run.md): an OS sandbox for run and start
- [features/policy.md](features/policy.md): harness policy that AGENTS.talk cannot widen
- [infrastructure/tooling.md](infrastructure/tooling.md): language, tests, layout
- [infrastructure/parser.md](infrastructure/parser.md): parser output, errors, tree shape
- [infrastructure/security.md](infrastructure/security.md): all security decisions, deferred items
- [infrastructure/host.md](infrastructure/host.md): MCP host, host API, pi extension, Claude Code tool limits
