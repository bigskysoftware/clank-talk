# Secrets

Agents must use secrets (API keys, tokens) without seeing their values.

## Idea

- The user keeps secrets in `.env` or a similar store. The agent cannot read that file.
- A script refers to a secret by name. The runtime gives an opaque value, not the text.
- The runtime puts the real value in only at an allowed sink, for example a fetch header to an allowed host.
- The audit log records the secret name, never the value.

## Open questions

- Syntax: TODO
- Which sinks can accept a secret: TODO (fetch headers, AGENTS.talk tools)
- Per-secret host allowlist: TODO
- Relation to taint: a secret is a taint label that must not reach output or files: TODO
- What happens if a script tries to print, write or compare a secret: TODO
- Redaction of a value that comes back in a response: TODO
