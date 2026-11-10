# Secrets

Built: `secret NAME` with fetch. Not built yet: `allow secret NAME for run`.

Agents must use secrets (API keys, tokens) without seeing their values.

## The problem today

- Before 2026-11-09, scripts could read `.env`, so an agent saw every secret in it. Fixed: see the next rule.
- A tool that needs a secret must get it from the environment through `allow env`, and the agent can print the tool's output, which can hold the secret.
- Fetch with a token header needs the token in the script as text.

## Rules

### Where secrets come from

- Approved (built): the runtime looks for a value in this order, and the first match wins: the environment of the server process, then `@/.env.local`, then `@/.env`. Why: Vite, Next.js, dotenv-flow and dotenv (Node and Ruby) all let the environment win over the files, and `.env.local` win over `.env`. Not read: mode files such as `.env.development` (ClankTalk has no mode), and files in subfolders. The OS keychain comes later.
- Approved (built): the `.env` files use the dotenv form: `KEY=value` lines, `#` comments, an optional `export `, and values in single or double quotes. In double quotes, `\n` is a line break. Without quotes, ` #` starts a comment. An empty value counts as no value.
- Approved (built): scripts cannot read `.env` or `.env.*` in any folder: `read`, `text`, `lines`, `first`, `last` and `find` give `A script cannot read .env files, because they hold secrets: <path>`. The check uses the path as written and the path after links. Globs leave these files out. `exists` still works. In `git diff` and `git show` output, the part for a `.env` file is one line: `(a .env file: not shown, since it holds secrets)`, and `git diff` that names a `.env` file is refused.
- Approved (built): `allow secret NAME for fetch to '<host>', ...` at the top of AGENTS.talk. Only AGENTS.talk can have it, not an imported file. Host patterns work as in `allow fetch from`.

```talk
# AGENTS.talk
allow secret GITHUB_TOKEN for fetch to 'api.github.com'
```

- Approved (built): the runtime reads the values of all allowed names when AGENTS.talk loads, on each run, so a changed `.env` takes effect at once. A value shorter than 8 characters fails the load: `The value of secret X is shorter than 8 characters, so it cannot be kept out of the output. Use a longer value, or remove the allow line.`
- Approved (built): a missing value is an error only where a script uses it: `No value for secret GITHUB_TOKEN. Put it in the environment, in .env.local or in .env.` No warning at load time, because it would show on every script.

### Using a secret

- Approved (built): `secret NAME` is a value. A script cannot get its text. `secret` is a keyword only when a name follows it on the same line, so `set secret to 1` still works.
- Approved (built): a name with no `allow secret` line is an error that gives the line to add.
- Approved (built): `'Bearer ' + secret X` and `'Bearer ${secret X}'` are still secrets. Only `+` and `${}` join.
- Approved (built): `print` shows `<secret NAME>`, also inside lists and objects. A secret can go in a variable, a `$` global, a list, an object, or a tool argument.

```talk
fetch https://api.github.com/user as json with headers: { Authorization: 'Bearer ' + secret GITHUB_TOKEN }
```

- Approved (built): the real value goes only into fetch headers and the body (also a JSON body), and only to the hosts in its `allow secret` line. Another host is an error: `A secret cannot go to example.com: GITHUB_TOKEN. It can go only to api.github.com.` The normal fetch host check also applies: `allow secret` does not skip the question for a new host.
- Approved (built): a secret in the fetch URL is an error, because URLs go into the audit, hooks and errors. Later: maybe, with redaction.
- Approved (built): any other use is an error: files (`write`, `append`, `replace`, `put`), programs (`run` and `start` arguments, git), `ask`, checks (`is`, `contains`, `starts with`, `matches`, `is empty`, `exists` and the others, because each tells one bit), and conversions (`as text`, `as json`, `length`, indexes). The error says where the secret can go: `A secret cannot go into write: GITHUB_TOKEN. Use it in fetch headers or body to api.github.com.` `on error` can catch it.
- Approved (built): every conversion to text checks for a secret, and only `print`, `+`, `${}` and fetch handle one. A place that the code misses gives an error, and does not leak the value. Why not `<secret NAME>` text: written to a file in silence, it is a quiet bug.

### Leaks back

- Approved (built): the exact text of each allowed secret shows as `<secret NAME>` in: `run` output, process output, fetch responses (text and headers), print output, errors, warnings, and the audit. `the previous output` comes from print output, so it is covered too.
- Approved (built): file reads are not changed. Why: `replace` in a file with a token would write `<secret X>` and lose the token. Gap: a script can read a file with a token and send that text to an allowed host. Taint must close this gap.
- Gap: the changed-files diff that the MCP host shows can hold a secret's value from a file. Same cause as file reads.
- Limit: redaction finds the exact text only. A program that changes the value (for example base64) can still leak it. Only the sandbox (no network) limits that.

### Audit and hooks

- Approved (built): the audit records the names, never the values: `fetch  GET https://api.github.com/user  200, 1234 bytes  (secret GITHUB_TOKEN)`.
- Approved (built): the fetch step has `secrets`, the list of names, so a hook can check a fetch that sends a token.
## Decisions

- Approved: the syntax: `secret NAME` as a value, and `allow secret NAME for fetch to <host>` or `allow secret NAME for run` in AGENTS.talk.
- Approved: `allow env` stays as it is: the opt-in for any environment variable that `run` passes on. `allow secret ... for run` is a second way, for values from `.env`, with redaction.
- Approved: the OS keychain comes later.
- Approved: no taint yet. Secrets are built on their own, not as a taint label. See [taint.md](taint.md).
