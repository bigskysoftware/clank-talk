# Secrets

Syntax approved. Not built yet. The rules without an "Approved" mark are still proposed.

Agents must use secrets (API keys, tokens) without seeing their values.

## The problem today

- Before 2026-11-09, scripts could read `.env`, so an agent saw every secret in it. Fixed: see the next rule.
- A tool that needs a secret must get it from the environment through `allow env`, and the agent can print the tool's output, which can hold the secret.
- Fetch with a token header needs the token in the script as text.

## Proposal

### Where secrets come from

- Proposed: secrets live in `.env` (and later, maybe, the OS keychain). The runtime reads `.env` itself. Scripts cannot.
- Approved (built): scripts cannot read `.env` or `.env.*` in any folder: `read`, `text`, `lines`, `first`, `last` and `find` give `A script cannot read .env files, because they hold secrets: <path>`. The check uses the path as written and the path after links. Globs leave these files out. `exists` still works. Later, with `secret NAME`, the error can say to use a secret by name. Not covered: `git show` or `git diff` of a `.env` file that is in git, and the output of programs.
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

## Decisions

- Approved: the syntax: `secret NAME` as a value, and `allow secret NAME for fetch to <host>` or `allow secret NAME for run` in AGENTS.talk.
- Approved: `allow env` stays as it is: the opt-in for any environment variable that `run` passes on. `allow secret ... for run` is a second way, for values from `.env`, with redaction.
- Approved: the OS keychain comes later.
- Approved: no taint yet. Secrets are built on their own, not as a taint label. See [taint.md](taint.md).
