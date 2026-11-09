# Core tools

The runtime includes these capabilities by default.

## File system

- Read, write, list, delete, move: TODO
- Scope: a root directory. Paths outside the root fail.
- Every write records undo data.

## Fetch

See [fetch.md](fetch.md). Later: response values are tainted.

## Not included

- General process execution. Users expose specific commands through AGENTS.talk.
