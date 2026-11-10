# Policy

Approved. Not built yet.

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
- Approved: `deny <what>`: `git push`, `start`, `fetch`, `run`, `writes` (read-only session). A tool in AGENTS.talk that uses a denied thing is a load error.
- Approved: policy hooks run before AGENTS.talk hooks, and AGENTS.talk cannot remove them.
- Approved: `allow git push` in AGENTS.talk does nothing under `deny git push`: it is a load error.

## Errors

- Approved: a load error names both files and lines: `AGENTS.talk 4:1 'allow fetch from 'evil.com'' is outside the policy: policy.talk 9:1 limits fetch to 'api.github.com', '*.acme.internal'`. Nothing runs until AGENTS.talk is fixed.

## Limits

- On the user's own machine, the user can start the agent without the harness. The law covers that; the audit (with its copy outside the project) makes it visible.
- The harness must also lock its own side: the agent must not reach the machine around ClankTalk (for example, Claude Code managed settings that deny the built-in tools and allow only the ClankTalk MCP server).
