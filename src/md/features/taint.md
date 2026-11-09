# Taint

Values carry provenance labels. The runtime propagates labels through operations.

- Sources: fetch results, TODO
- Sinks: file write, AGENTS.talk tools, TODO
- Hooks decide what happens when a tainted value reaches a sink.

## Open questions

- Label model: TODO
- Propagation through string operations and control flow: TODO
