# Sandbox

The runtime is the sandbox. A script can do only what the runtime gives it.

## Decision: in-process interpreter

Built this way. Reasons:

- We control the parser and the interpreter. No eval and no JS escape exist.
- Audit, taint and undo need access to every step. In-process makes this direct.

## Required rules

- Scripts do not get raw host objects. Values pass through a safe boundary.
- Property access must block `constructor`, `__proto__` and `prototype`.
- The interpreter counts steps and enforces a budget. This stops infinite loops.
- TODO: memory limit. An in-process runtime cannot enforce this well.

## Fallback

Keep the host interface narrow. Then the runtime can move to a worker or WASM isolate later.
