# Core tools

The runtime includes these capabilities by default.

## File system

- Read, write, list, delete, move: TODO
- Scope: a root directory. Paths outside the root fail.
- Every write records undo data.

## Fetch

- HTTP requests: TODO
- Allowed hosts: TODO
- Response values are tainted.

## Not included

- General process execution. Users expose specific commands through AGENTS.talk.
