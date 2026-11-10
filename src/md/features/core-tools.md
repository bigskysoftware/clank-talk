# Core tools

The runtime includes these capabilities by default.

## File system

- Built: read, write, append, replace, find, put, remove, move, delete, and globs to list files. See [language.md](language.md) and `help`.
- Scope: a root directory. Paths outside the root fail.
- Every write records undo data.

## Fetch

See [fetch.md](fetch.md). Later: response values are tainted.

## Not included

- General process execution. Users expose specific commands through AGENTS.talk.
