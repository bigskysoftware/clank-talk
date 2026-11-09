# Undo

The runtime keeps a per-step undo stack. Undo covers as many actions as is practical.

- File system: record previous content before each change.
- Fetch: no undo. The audit records it.
- AGENTS.talk tools: TODO
- Plugins: TODO
