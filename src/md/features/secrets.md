# Secrets

Proposed. Nothing here is built. For the human to review.

Agents must use secrets (API keys, tokens) without seeing their values.

## The problem today

- Scripts can read `.env`, so an agent sees every secret in it. Hidden files are protected from changes, not from reads.
- A tool that needs a secret must get it from the environment through `allow env`, and the agent can print the tool's output, which can hold the secret.
- Fetch with a token header needs the token in the script as text.

## Proposal

### Where secrets come from

- Proposed: secrets live in `.env` (and later, maybe, the OS keychain). The runtime reads `.env` itself. Scripts cannot.
- Proposed: scripts cannot read `.env` or `.env.*` at all: a read is an error that says to use a secret by name. This closes the leak today. (Today only the sandbox blocks `.env` reads.)
- Proposed: AGENTS.talk lists which secrets exist for scripts, and where each may go:

```talk
# AGENTS.talk
allow secret GITHUB_TOKEN for fetch to 'api.github.com'
allow secret NPM_TOKEN for run
```

### Using a secret

- Proposed: `secret NAME` is a value. Its text is never shown: `print secret GITHUB_TOKEN` prints `<secret GITHUB_TOKEN>`.

```talk
fetch https://api.github.com/user as json with headers: { Authorization: 'Bearer ' + secret GITHUB_TOKEN }
```

- Proposed: a secret joined with text (`'Bearer ' + secret X`) is still a secret, and still prints as `<secret ...>`.
- Proposed: the real value is put in only at an allowed sink:
  - `for fetch to <host>`: in fetch headers and the body, and only to that host (redirects to other hosts drop it).
  - `for run`: as an environment variable for the program, by its name, inside tools.
- Proposed: anywhere else it is an error: write it to a file, put it in a `run` argument, use it in a commit message, compare it (`is`, `contains`), or put it in a string that leaves the script. The error says where the secret may go.

### Leaks back

- Proposed: the runtime redacts known secret values in everything that comes back: tool and `run` output, fetch responses, process output, error messages. Each value is replaced with `<secret NAME>`.
- Limit: redaction finds the exact text only. A program that changes the value (for example base64) can still leak it. Only the sandbox (no network) limits that.

### Audit

- Proposed: the audit records the secret's name, never its value. `fetch GET https://api.github.com/user  (secret GITHUB_TOKEN)`.

## Open questions for the human

- The syntax: `secret NAME` as a value, and `allow secret NAME for ...` in AGENTS.talk.
- Should a `run` tool get secrets only through `allow secret ... for run`, and no longer through `allow env`? (`allow env` would then be for plain settings, like PATH.)
- The keychain: later, or never?
- How this meets taint: a secret is the first taint label. See [taint.md](taint.md).
