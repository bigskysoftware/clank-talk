<div class="features">

<img class="page-robot" src="img/clanktalk-robot.png" alt="A friendly robot">

<p><a href="./">Home</a> | <a href="docs.html">Docs for Humans</a> | <a href="reference.html">Docs for Agents</a> | <a href="https://github.com/bigskysoftware/clank-talk">GitHub</a></p>

# Policies for Teams

A ClankTalk policy is a file of rules that your organization ships with its agent harness. It sets limits for every agent session, and no project can widen them.

<h2 id="why">Why a Policy</h2>

Each project has an `AGENTS.talk` file. The developers of the project write it, and it says what agents can do in that project. That is right for one project, but an organization needs rules that hold everywhere:

- Every program that an agent starts runs in an OS sandbox.
- Agents reach only approved hosts, with only approved credentials.
- Agents do not push code, or change files in some sessions.
- There is a full record of each session, kept for the time that compliance requires, in a place that the project cannot change.

A policy gives these rules. The policy is written in ClankTalk, the same language as `AGENTS.talk`, so security reviewers can read it.

<h2 id="example">An Example Policy</h2>

```talk policy.talk
policy 'acme-secure'

# every program runs in the OS sandbox
require sandbox for run, start

# ceilings: an AGENTS.talk can allow only a part of these
limit fetch from 'api.github.com', '*.acme.internal'
limit env to PATH, HOME, JAVA_HOME
limit changes to @/.github/
limit secrets to GITHUB_TOKEN
limit output keeping the first 200 and the last 200 lines or 20 KB

# things that are off, whatever AGENTS.talk says
deny git push
deny start
deny subagents

# a record for compliance, and a copy that the project cannot touch
keep audit for at least 30 days
audit also to '/var/log/clank-talk/'

# hooks that always run first; AGENTS.talk hooks run after them
before fetch
  if the fetch's method is not 'GET'
    reject 'Only GET in this session'
  end
end
```

<h2 id="controls">The Controls</h2>

| Rule | Effect |
|---|---|
| `require sandbox for run, start` | A tool that runs or starts a program with no `in a sandbox` is an error. |
| `limit fetch from '<host>', ...` | Agents reach only these hosts. A host outside the list is refused, with no question to the user. |
| `limit env to <NAME>, ...` | Programs get only these environment variables. |
| `limit changes to <path>, ...` | Projects can allow changes only to these hidden files and folders. |
| `limit secrets to <NAME>, ...` | Projects can use only these secrets. |
| `deny secrets` | Projects cannot use secrets. |
| `taint required` | Session taint stays on: a project cannot turn it off, and neither can `npx clank-talk taint off`. |
| `limit output keeping <lines> [or <n> KB]` | Agents see only these lines of the output of one script: the first, the last, both, or lines matching a pattern. |
| `deny git push` | No push. |
| `deny start` | No background programs, such as servers. |
| `deny run` | No programs. |
| `deny fetch` | No network access from scripts. |
| `deny writes` | A read-only session: no file changes, and no git changes. Add `deny run` and `deny start` for a session where nothing can write. |
| `deny subagents` | No subagents. |
| `keep audit for at least <n> days` | The audit is kept for at least this many days. A project cannot keep it for fewer. |
| `audit also to '<folder>'` | A copy of the audit goes to a folder outside the project. This copy is never deleted by ClankTalk. |
| `before ...` and `after ...` hooks | Hooks that run before the hooks of the project. A project cannot remove them. |

Each rule applies when `AGENTS.talk` loads, and again at each step while a script runs. A script cannot get around a rule.

<h2 id="conflicts">When a Project Goes Past the Policy</h2>

A conflict is an error, not a silent change. If `AGENTS.talk` allows more than the policy, nothing runs until the project is fixed. The error names both files and both lines:

```text
AGENTS.talk 1:1 'allow fetch from 'evil.example'' is outside the policy: policy.talk 5:1 limits fetch to api.github.com, *.acme.internal
```

<h2 id="deploy">Deploying a Policy</h2>

The harness starts ClankTalk with the policy file. The file lives with the harness, outside every project, so agents cannot read or change it.

- **MCP server:** `clank-talk-mcp --policy /etc/clank-talk/policy.talk --policy-hash <sha256>`
- **pi:** `pi --clank-policy /etc/clank-talk/policy.talk --clank-policy-hash <sha256>`
- **Your own harness:** `run(script, { policy: { name, source } })`

With the hash, ClankTalk refuses to start if the policy file was changed.

<h2 id="evidence">Evidence</h2>

The header of each script in the audit names the policy and a short hash of it:

```audit
== 10:42:01  script 12 (main)  done  14 steps  (policy acme-secure 3f9a2c1b) ==
```

Thus a session that ran with no policy, or with a changed policy, shows in the audit. The goal is a record that is tamper-evident: a change cannot be silent.

<h2 id="limits">Limits</h2>

- A policy limits what ClankTalk does. It does not limit other tools that a harness gives to the agent. Turn those tools off in the harness.
- The OS sandbox limits files and the network, not CPU or memory.
- A person with access to the machine can start a session without the policy. The audit header shows it.

</div>