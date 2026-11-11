# Policy

Approved. Built: loading, the rules below, and `audit also to`.

A policy is a ClankTalk file that the harness provides. It sets limits that the user's AGENTS.talk cannot widen. For sensitive sessions.

## Decisions (approved by the human)

- Approved: the harness is provided to users, and changing it is not allowed by law. So the goal is tamper-evident, not tamper-proof: a change must be loud and recorded.
- Approved: the policy is ClankTalk, the same language as AGENTS.talk.
- Approved: a conflict between the policy and AGENTS.talk is loud: an error when AGENTS.talk loads, not a silent clamp.

## Three layers

| Layer | Written by | Can |
|---|---|---|
| policy | the harness | set limits, require things, add hooks that always run |
| AGENTS.talk | the user | add tools, hooks, and allows inside the policy's limits |
| script | the agent | do the work, inside both |

Each layer can only narrow the one above it, never widen it.

## Loading

- Approved: the harness starts the server with `--policy <file>`. The file lives with the harness, outside the project.
- Approved: a custom harness that embeds the runtime passes the policy as text: `run(script, { policy: { name, source } })`. The harness is trusted, so there is no hash check, but the audit still records the hash. Both ways load through the same code.
- Approved: sessions can have different policies. One MCP server process is one session, so the harness starts each session's server with its own `--policy`. With the runtime API, the policy goes with each `run()` call. The runtime keeps no policy between runs.
- Approved: the MCP client cannot supply a policy (for example in `initialize`): the client is not the harness owner's code in every setup, and a policy that can arrive that way can also silently not arrive.
- Approved: the policy loads before AGENTS.talk. Scripts cannot read or change it (it is outside the project root).
- Approved: `--policy-hash <sha256>`: the server refuses to start if the policy file does not match. The harness passes the hash it shipped with.
- Approved: the audit header of each script records the policy's name and a short hash: `== 10:42:01  script 12  done  14 steps  (policy acme-secure 3f9a2c1b) ==`. Thus a session run without the policy, or with a changed one, is visible in the audit.
- Approved: the policy can send a copy of the audit outside the project, where the user's project tools cannot reach it.

## What a policy can say

```talk
# policy.talk, shipped with the harness
policy 'acme-secure'

# every program runs in the OS sandbox
require sandbox for run, start

# ceilings: AGENTS.talk may allow only a subset
limit fetch to 'api.github.com', '*.acme.internal'
limit env to PATH, HOME, JAVA_HOME
limit changes to @/.github/
limit output keeping the first 200 and the last 200 lines or 20 KB

# things that are off, whatever AGENTS.talk says
deny git push
deny start

# a copy of the audit that the project cannot touch
audit also to '/var/log/clank-talk/'

# hooks that always run first; AGENTS.talk hooks run after them
before fetch
  if the fetch's method is not 'GET'
    reject 'Only GET in this session'
  end
end
```

- Approved: `require sandbox for run, start`: a `run` or `start` with no `in a sandbox` is a load error in AGENTS.talk (loud), not only a runtime error.
- Approved: `limit <what> to <list>`: a ceiling. An `allow` in AGENTS.talk outside it is a load error that names the policy line.
- Approved: `deny <what>`: `git push`, `start`, `fetch`, `run`, `writes` (read-only session), `secrets`, `subagents`. A tool in AGENTS.talk that uses a denied thing is a load error.
- Approved: policy hooks run before AGENTS.talk hooks, and AGENTS.talk cannot remove them.
- Approved (built): `deny writes` denies file changes (`write`, `append`, line edits, `replace` in a file, `undo`) and git changes (`switch`, `commit`, `merge`, `delete`). It does not cover programs: a program in a sandbox can write in the project. For a read-only session, also `deny run` and `deny start`.
- Approved (built): the rules apply at load time to AGENTS.talk tools and hooks, and again at run time to each step. Thus a script cannot get around them.
- Approved (built): under `limit fetch`, a host outside the limit is refused. The human is not asked.
- Approved (built): `limit secrets to GITHUB_TOKEN, NPM_TOKEN`: an `allow secret` line for another name is a load error. `deny secrets`: any `allow secret` line is a load error. A host in `allow secret ... for fetch to` outside `limit fetch to` is a load error, the same as `allow fetch from`. See [secrets.md](secrets.md).
- Approved (built): `limit output keeping ...` chooses the print output that the agent sees, with the same forms as `run ... keeping`. AGENTS.talk cuts first, then the policy, then the host. See [host.md](../infrastructure/host.md). Replaced: `limit output to <n> lines [or <n> KB]`, which is now an error that names the new form.

## Errors

- Approved: a load error names both files and lines: `AGENTS.talk 4:1 'allow fetch from 'evil.com'' is outside the policy: policy.talk 9:1 limits fetch to 'api.github.com', '*.acme.internal'`. Nothing runs until AGENTS.talk is fixed.

## Limits

- On the user's own machine, the user can start the agent without the harness. The law covers that; the audit (with its copy outside the project) makes it visible.
- The harness must also lock its own side: the agent must not reach the machine around ClankTalk (for example, Claude Code managed settings that deny the built-in tools and allow only the ClankTalk MCP server).
