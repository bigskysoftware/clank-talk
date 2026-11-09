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
- [features/sandbox.md](features/sandbox.md): isolation model, in-process runtime
- [features/core-tools.md](features/core-tools.md): built-in fs and fetch
- [features/plugins.md](features/plugins.md): explicit imports for syntax and tools
- [features/agents-talk.md](features/agents-talk.md): user-defined tools in AGENTS.talk
- [features/audit.md](features/audit.md): per-step action log
- [features/taint.md](features/taint.md): value provenance and sink checks
- [features/undo.md](features/undo.md): per-step undo stack
- [features/hooks.md](features/hooks.md): user policy and security hooks
- [infrastructure/host.md](infrastructure/host.md): host API, pi extension, Claude Code tool limits
