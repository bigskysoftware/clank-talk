<div class="features">

<img class="page-robot" src="img/clanktalk-robot.png" alt="A friendly robot">

<p><a href="./">Home</a> | <a href="reference.html">Docs for Agents</a> | <a href="https://github.com/bigskysoftware/clank-talk">GitHub</a> | <a href="https://github.com/sponsors/bigskysoftware">Sponsor</a></p>

# ClankTalk Docs

<ul class="areas">
<li><a href="#overview">Overview</a></li>
<li><a href="#install">Install</a></li>
<li><a href="#agents-talk">Your AGENTS.talk</a></li>
<li><a href="#reading-output">Reading Your Agent's Work</a></li>
<li><a href="#harness-notes">Harness and Agent Notes</a></li>
<li><a href="#fine-print">The Fine Print</a></li>
</ul>

<div class="construction">

ClankTalk is under construction!

</div>

<h2 id="overview">Overview</h2>

ClankTalk is a scripting language designed mainly for agents to write and for humans to read.  Humans write a little bit of it, defining tools and policies for agents in the ClankTalk runtime, but that's pretty much it. 

ClankTalk is an [xTalk](https://en.wikipedia.org/wiki/HyperTalk) language, which reads like English.  As I learn every time [hyperscript](https://hyperscript.org) is posted to HackerNews or Reddit, many people dislike *writing* code in this style.  But I think, if you have an open mind, you can agree that it at least _reads_ well.

And, for a language intended to be written by agents and read by humans... it's just about perfect.

The ClankTalk runtime is designed to be a replacement for giving your agent unrestricted shell access.  

If you think about it, it's pretty crazy that we do this:
 shell can run any program, with all of your rights.  It can read your secrets: `.env`, `~/.ssh`, cloud credentials.  It can send anything to any host. It can change or delete any file, also outside the project.  Pipes, quotes and `$(...)` make its commands hard to read, and harder to audit.

<div class="compare">

```bash bump.sh
for f in ./config/*.json; do
  v=$(jq -r '.version' "$f")
  if [ "$v" -lt 2 ]; then
    jq '.version = 2' "$f" > "$f.tmp" \
      && mv "$f.tmp" "$f"
  fi
done
```

```talk bump.talk
for file in ./config/*.json
  set config to the file's text as json
  if config's version is less than 2
    set config's version to 2
    write config as json to the file
  end
end
```

</div>
<script src="js/compare.js"></script>

ClankTalk replaces this, let's just say it, digital anarchy, with a much more controlled runtime environment for your agents to do work in, providing:

- **[File access limits](#sandboxing):** scripts stay inside the project root. They cannot change `.talk` files or hidden files such as `.env` and `.git/`, unless you allow it.
- **[Your own tools](#tools):** no shell. Programs run only through the tools that you define in `AGENTS.talk`, and can run in an OS-level sandbox.
- **[Secrets Management](#secrets):** your agent can use the secrets you allow it, but can't see the values.
- **[Taint tracking](#taint):** Tainted external input is tracked and can be used to make policy decisions.
- **[Hooks](#hooks):** You get callbacks for all actions an agent wants to take.
- **[An audit log](#audit):** saved in `.talk/audit/` that shows you what the agent did.
- **[Undo](#undo):** allows you to revert file changes, one script at a time, even without git.
- **A hardened git:** with no hooks, pagers or --force.
- **Limits:** a step budget and time limits stop runaway scripts.

The ClankTalk environment isn't perfect, of course, but it gives you a lot more control and observability when compared with most agent runtimes today.

<h2 id="install">Install</h2>


ClankTalk runs as an [MCP](https://modelcontextprotocol.io) server with one tool, `clank_talk`.  There is also a pi package available for it.

The nice thing about this architecture is that it can work with any agent and in any harness: all you have to do is enable the MCP server and then turn off all (or most) of the other tools available, and the agent
will start using it.

<div class="install-area">
<div class="install install-docs">
<div class="install-picker">
<span class="install-label">Pick Your Harness</span>
<button class="install-button" type="button" aria-haspopup="listbox" aria-expanded="false"><span class="agent-icon claude">C</span><span class="install-name">Claude Code</span><span class="install-chevron"></span></button>
<ul class="install-menu" role="listbox" hidden>
<li role="option" tabindex="0" data-agent="claude"><span class="agent-icon claude">C</span>Claude Code</li>
<li role="option" tabindex="0" data-agent="pi"><span class="agent-icon pi">&pi;</span>pi</li>
<li role="option" tabindex="0" data-agent="other"><span class="agent-icon other">M</span>Other MCP clients</li>
</ul>
</div>
</div>


<div class="harness" data-agent="claude">

### Claude Code

Save this as `.mcp.json` at the root of your project:

```json
{
  "mcpServers": {
    "clank-talk": {
      "command": "npx",
      "args": ["-y", "-p", "clank-talk@0.2", "clank-talk-mcp"]
    }
  }
}
```

Then take away the agent's other tools:

```bash
$ claude --tools "" --allowedTools mcp__clank-talk
```



</div>

<div class="harness" data-agent="pi" hidden>


### pi

```bash
$ pi install -l git:github.com/bigskysoftware/clank-talk
```

TODO (Carson): pi notes.

- It runs inside pi: `ask` and fetch approvals are pi dialogs, and it turns off every other tool for you. No flags to forget.
- Try it once with no install: `pi -e git:github.com/bigskysoftware/clank-talk`.
- Careful with `pi install` without `-l`: every pi session on the machine then gets only ClankTalk.

</div>

<div class="harness" data-agent="other" hidden>

### Other agents

TODO (Carson): Codex, Cursor and other MCP clients use the same server; see the install box on the [home page](./).

</div>
</div>
<script src="js/install.js"></script>

If you are using ClankTalk, I recommend that you put the following directions in your `AGENTS.md`

```md
## Tools

Use the clank_talk tool for all work: reading, editing, search, git and tests.
Do not use a shell or other file tools.  If other tools are available warn the user.
If ClankTalk cannot do a task, stop and tell the human what is missing.
```


<h2 id="agents-talk">Your AGENTS.talk</h2>

As I mentioned, you, the reader, will not likely write very much ClankTalk (you will mostly be reading the ClankTalk your agent wrote.)  However, there is one area where you will be asked to write some code: the `AGENTS.talk` file.

### The File

The `AGENTS.talk` file in the root of a project is loaded by the ClankTalk environment when it starts up and defines:

* What agents are allowed to do
* Callbacks when agents take action
* Various other configuration options

Here is a simple `AGENTS.talk` file:

```talk
# AGENTS.talk
allow env PATH, HOME

# Runs the full test suite.
tool run_tests
  run 'npm test' in a sandbox with local network
end
```

This file passes the `PATH` and `HOME` environment variables on to the programs that its tools run, and defines a custom tool for running the tests in the project.  Agents can then execute `run_tests`, and read what it gives back: `set tests to run_tests` then `print tests's output`.

The `AGENTS.talk` file lives at the root of your project. ClankTalk resolves the project root in the following order:

1. `--root /path/to/project`, if you start the MCP server with it.
2. The environment variable `CLANK_TALK_ROOT=/path/to/project`.
3. The folder where your agent starts.

Agents cannot modify any `.talk` files in your project, so they are a protected space for you to write permissions and tools for them.


- Scripts cannot reach files outside the root.
- ClankTalk does not look in parent folders for `AGENTS.talk`. If you start your agent in a subfolder, and a folder above it has an `AGENTS.talk`, ClankTalk warns you and your agent, and names the folder. It does not change the root for you, because a higher root gives scripts more files.
- Add `.talk/` to `.gitignore`: it holds the audit log and the taint labels.

TODO (Carson): intro. We start with the file above, and add lines as real needs come up. Each step shows only the new lines; the whole file is at the end.

<h3 id="tools">One Test File at a Time</h3>

TODO (Carson): the problem: the full suite is slow, and the agent only changed one file.

```talk AGENTS.talk
# Runs one test file.
tool run_test with file
  run 'node' with '--test', file in a sandbox
end
```

Your agent then calls it with a file:

```talk
set tests to run_test './test/app.test.js'
if tests's code is not 0
  print find 'FAIL' in tests's output
end
```

- A parameter is a value that your agent gives. You write the program; your agent gives only the arguments.
- `run` works only in a tool, never uses a shell, and passes on only the variables in `allow env`.
- A value from your agent cannot start with `-`, so it cannot be an option, unless it comes after a `'--'` that you wrote.
- A file value is its path, such as `./test/app.test.js`. In `run 'npm test ${name}'`, the value of `name` is one argument, also with spaces in it.

### When the Tests Hang

TODO (Carson): the problem: a test waits forever, and so does the agent.

```talk AGENTS.talk
# Runs the full test suite.
tool run_tests
  run 'npm test' in a sandbox with local network within 10 minutes
end
```

- After 10 minutes the program stops, with the programs that it started.
- Your agent can set a shorter limit on a call: `run_tests within 2 minutes`. The shorter limit wins.

<h3 id="sandboxing">A Cache Outside the Project</h3>

TODO (Carson): the problem: the browser tests need the browsers that Playwright keeps in your home folder, and the sandbox cannot see them.

```talk AGENTS.talk
# Runs the full test suite.
tool run_tests
  run 'npm test' in a sandbox with local network, reads of '~/.cache/ms-playwright' within 10 minutes
end
```

- Your agent writes code, and `npm test` runs code, so a test tool can run anything your agent writes. That is why tools say `in a sandbox`.
- In a sandbox: writes only to the project (not `.git`, `.talk` or hidden files), reads only system folders, install folders and caches, no network, and a fresh home folder.
- Options: `with network`, `with local network`, `writes to <path>`, `reads of <path>`.
- macOS (`sandbox-exec`) and Linux (`bubblewrap`). Elsewhere a sandboxed `run` is an error; it never runs without the sandbox. A self-test runs first.
- Ubuntu 23.10 and later: AppArmor can block `bubblewrap`. Fix: `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, or an AppArmor profile for `bwrap`.

### The Dev Server

TODO (Carson): the problem: your agent wants to see the page that it changed.

```talk AGENTS.talk
allow fetch from 'localhost'

# Starts the dev server.
tool dev_server
  start 'npm run dev' as 'dev' in a sandbox with local network
end
```

Your agent then starts it, and waits for it:

```talk
dev_server
wait until (fetch http://localhost:5173/ as response)'s status is 200 within 15 seconds
print the output of process 'dev'
```

- `start` keeps a program running. Your agent can wait for it, read its output, and stop it with `stop process 'dev'`. The end of the session stops them all.
- `localhost` and other private addresses must be in an `allow fetch from` line.

### Installing Packages

TODO (Carson): the problem: `npm install` needs the network, and a place for its cache.

```talk AGENTS.talk
# Installs the dependencies.
tool install
  run 'npm install' in a sandbox with network, writes to '~/.npm'
end
```

- `with network` opens the network for this program only.
- `writes to '~/.npm'` adds one folder outside the project that the program can write.

### Fixing the CI Config

TODO (Carson): the problem: the CI config is in `.github/`, and your agent cannot change hidden files.

```talk AGENTS.talk
allow changes to @/.github/
```

TODO (Carson): scripts cannot change `.talk` files (so the agent cannot change its tools) or hidden files (`.env`, `.git/`, `.github/`); the agent tells you the line to add. `.env` files cannot even be read.

- Scripts cannot read `.env`, `.env.*` or `.envrc`, in any folder.
- Scripts cannot change a file that is not UTF-8 text, so a binary file is safe from a `replace`.
- You and your agent can work on the same files: if you save a file after the agent read it, its next write fails, and your change stays.

<h3 id="taint">Reading GitHub Issues</h3>

TODO (Carson): the problem: your agent reads issues, and anyone on the internet can write an issue.

```talk AGENTS.talk
# Shows a GitHub issue.
untrusted tool issue with id
  run 'gh' with 'issue', 'view', id in a sandbox with network, reads of '~/.config/gh'
end
```

- `untrusted` marks what the tool gives back. Text from fetch, an `untrusted tool` or a subagent is untrusted. Text from files, git and programs is private.
- Labels follow values, and stay with files you write (`.talk/taint.json`).
- Untrusted text in `run`, `start`, a commit or a branch name asks you first. Private text in a fetch asks once for each host.
- Limits: the agent can retype what it read; an `if` passes no labels; taint cannot see inside a program.

<h3 id="secrets">Calling the GitHub API</h3>

TODO (Carson): the problem: the API needs your token, and your agent must not see it.

```talk AGENTS.talk
allow fetch from 'api.github.com'
allow secret GITHUB_TOKEN for fetch to 'api.github.com'
```

Your agent then uses the token by name:

```talk
fetch https://api.github.com/user as json with headers: { Authorization: 'Bearer ' + secret GITHUB_TOKEN }
```

TODO (Carson): the first fetch to a new host asks you; `localhost` and private addresses must be listed; each redirect goes into the audit.

- Your agent uses a key by name, and never sees it: print shows `<secret GITHUB_TOKEN>`, and any other use is an error.
- Values come from the environment, then `.env.local`, then `.env`.
- A value that comes back (output, responses, errors, the audit) shows as `<secret NAME>`.

### Publishing to npm

TODO (Carson): the problem: publishing needs a token in the environment of `npm`.

```talk AGENTS.talk
allow secret NPM_TOKEN for run

# Publishes the package.
tool publish
  run 'npm publish' using secret NPM_TOKEN in a sandbox with network
end
```

- `using secret NPM_TOKEN` gives the program the token as an environment variable. It shows as `<secret NPM_TOKEN>` in the output.
- Risks: a program with a secret and the network can send it anywhere. Give secrets only to programs whose code your agent cannot change (`npm publish` runs scripts from `package.json`).

<h3 id="hooks">Every Program in a Sandbox</h3>

TODO (Carson): the problem: you want a rule, not a habit. Hooks are your security policy, as code that you can read.

```talk AGENTS.talk
before run
  if the run's sandbox is null
    reject 'Use a sandbox'
  end
end
```

- A `before` hook runs before each step of that kind. `reject` stops the step, and the script gets the message as an error.
- Steps: `read`, `write`, `append`, `replace`, `put`, `remove`, `move`, `delete`, `change` (any file change), `undo`, `run`, `start`, `stop`, `git`, `fetch`, or a tool name.
- A hook cannot change the step, and cannot run a program, also through a tool.

### No Web Text in Programs

TODO (Carson): the problem: you do not want text from an issue to reach a program at all, not even with a question.

```talk AGENTS.talk
before run
  if the run's args is untrusted
    reject 'No web text in programs'
  end
end
```

- A hook can check the taint labels of the step: `is untrusted` and `is private`.

### Ask Me Before a Push

TODO (Carson): the problem: a push is public, and you want to say yes first.

```talk AGENTS.talk
before git
  if the git's operation is 'push'
    ask 'Push this branch to origin?' with 'yes' or 'no'
    if the result is not 'yes'
      reject 'The human said no'
    end
  end
end
```

TODO (Carson): commit takes only named files; merge only fast-forwards; rebase is all or nothing; push sends the current branch, never with force; hooks, pagers and filters are off.

- Only you answer `ask`. No answer in 2 minutes is `null`, which means no.
- If the project is a subfolder of a repo, `git status`, `diff`, `show` and `log` cover only the project.

### Keep Out of the Migrations

TODO (Carson): the problem: database migrations are written by people.

```talk AGENTS.talk
before change
  if the change's path starts with 'migrations/'
    reject 'A human writes the migrations'
  end
end
```

- `change` covers every file change: write, append, replace, line edits, move, delete and undo.

### Deploys

TODO (Carson): the problem: your agent can deploy to staging, but a deploy to prod needs you.

```talk AGENTS.talk
# Deploys the app: staging or prod.
tool deploy with target
  run 'fly' with 'deploy', '--app', 'shop-' + target in a sandbox with network
end

before deploy
  if the deploy's args contains 'prod'
    ask 'Deploy to prod?' with 'yes' or 'no'
    if the result is not 'yes'
      reject 'Only a human can approve a prod deploy'
    end
  end
end
```

- A hook for a tool reads the tool's step by its name: `the deploy's args`, and `the deploy's named` for arguments by name.

### A Log of Failed Test Runs

TODO (Carson): the problem: you want to see how often the tests fail for your agent.

```talk AGENTS.talk
after run_tests
  if the result's code is not 0
    append 'tests failed\n' to ./tmp/test-failures.log
  end
end
```

- An `after` hook runs after the step, and `the result` is what the step gave back.

### Less Test Output

TODO (Carson): the problem: thousands of lines of test output fill your agent's context.

```talk AGENTS.talk
limit output to 400 lines
```

- Your agent sees at most 400 lines from one script. The middle is cut. The next script gets all of it as `the previous output`.

### Keeping the Audit

TODO (Carson): the problem: you want a week of history, in a form that your own tools can read.

```talk AGENTS.talk
keep audit for 7 days
audit as json
```

- The audit is in `.talk/audit/`, one file a day. With `audit as json`, each line is a JSON object.

### Summaries From a Model

TODO (Carson): the problem: your agent wants a summary of the open issues, without reading every one.

```talk AGENTS.talk
allow secret ANTHROPIC_API_KEY for subagents
use model 'claude-sonnet-5-5' for subagents with secret ANTHROPIC_API_KEY

# Summarizes the most important open issues.
tool summarize_issues
  run 'Summarize the most important open issues' in a subagent with only issue
end
```

- A subagent is a model that can call only the tools after `with only`. Those tools cannot write, fetch or use git.
- Its answer is always untrusted.
- In pi it uses pi's model, and needs no key.
- `start '...' as 'issues' in a subagent with only issue` runs it in the background.

### Sharing Tools

TODO (Carson): the problem: every project needs the same GitHub tools.

```talk AGENTS.talk
import ./talk/github.talk
```

- Put shared tools in a `.talk` file in `talk/`. Your agent cannot change `talk/`, or any `.talk` file.

### The Whole File

TODO (Carson): all of it together. The order: `allow`, `use model`, `limit` and `keep audit` lines at the top, then imports and tools, then hooks. Hooks run in the order that you write them.

```talk AGENTS.talk
allow env PATH, HOME
allow fetch from 'localhost', 'api.github.com'
allow changes to @/.github/
allow secret GITHUB_TOKEN for fetch to 'api.github.com'
allow secret NPM_TOKEN for run
allow secret ANTHROPIC_API_KEY for subagents
use model 'claude-sonnet-5-5' for subagents with secret ANTHROPIC_API_KEY
limit output to 400 lines
keep audit for 7 days
audit as json

# issue and summarize_issues
import ./talk/github.talk

# Runs the full test suite.
tool run_tests
  run 'npm test' in a sandbox with local network, reads of '~/.cache/ms-playwright' within 10 minutes
end

# Runs one test file.
tool run_test with file
  run 'node' with '--test', file in a sandbox
end

# Starts the dev server.
tool dev_server
  start 'npm run dev' as 'dev' in a sandbox with local network
end

# Installs the dependencies.
tool install
  run 'npm install' in a sandbox with network, writes to '~/.npm'
end

# Publishes the package.
tool publish
  run 'npm publish' using secret NPM_TOKEN in a sandbox with network
end

# Deploys the app: staging or prod.
tool deploy with target
  run 'fly' with 'deploy', '--app', 'shop-' + target in a sandbox with network
end

before run
  if the run's sandbox is null
    reject 'Use a sandbox'
  end
  if the run's args is untrusted
    reject 'No web text in programs'
  end
end

before git
  if the git's operation is 'push'
    ask 'Push this branch to origin?' with 'yes' or 'no'
    if the result is not 'yes'
      reject 'The human said no'
    end
  end
end

before change
  if the change's path starts with 'migrations/'
    reject 'A human writes the migrations'
  end
end

before deploy
  if the deploy's args contains 'prod'
    ask 'Deploy to prod?' with 'yes' or 'no'
    if the result is not 'yes'
      reject 'Only a human can approve a prod deploy'
    end
  end
end

after run_tests
  if the result's code is not 0
    append 'tests failed\n' to ./tmp/test-failures.log
  end
end
```

Every line above, and more, is in the [AGENTS.talk reference](agents-talk.html).

### Policies for Teams

TODO (Carson): for teams and harness owners: a policy file, shipped with the harness, sets limits that no `AGENTS.talk` can widen. See [Policies for Teams](policy.html).

<h2 id="reading-output">Reading Your Agent's Work</h2>

TODO (Carson): intro. You stay in charge: you read the scripts, answer the questions, check the audit, and undo.

<h3 id="reading">Reading a Script</h3>

TODO (Carson): a short tour for readers. The agent writes this; you need to read it.

- Comments start with `#`. Commands follow one another; `then` puts two on one line. Blocks close with `end`.
- `the` is optional. `robot's name`, `robot.name` and `the name of robot` are the same.
- Mixed math needs parentheses: `1 + 2 * 3` is an error, so nobody has to remember precedence.
- Most commands put their value in `it`, also called `the result`.
- A plain name is local to the script; a `$` name is a global that stays between scripts.
- Code, and text with quotes, goes in a text block: lines that start with `|`, exactly as typed.
- `on error` handles an error; with no `on error`, an error stops the script.
- Every command, with examples, is in the [Docs for Agents](reference.html).

```talk
# this is a comment
set robot to {name: 'clank', tags: ['agent', 'robot']}
print 'Hello, ${robot's name}!'

if robot's tags contains 'agent'
  print 'an agent'
end

replace
| const retries = 3;
with
| const retries = 5;
in ./src/config.js
```

### Questions From ClankTalk

```talk
ask 'Delete the old logs?' with 'yes' or 'no' within 5 minutes
if the result is 'yes'
  print 'ok'
end
```

TODO (Carson): only you answer; no answer is `null`, which means no.

- You get a question when the agent fetches from a new host, when untrusted text goes into a program, a commit or a branch name, and when private text goes to a host for the first time.
- Your agent can ask you too, with `ask`. Your hooks can ask you, as in [Hooks](#hooks).
- With no answer in 2 minutes, the answer is no.

<h3 id="audit">The Audit Log</h3>

```bash
tail -f .talk/audit/*.log
```

```audit
== 10:42:01  session claude-code-4f2a  script 12 (main)  done  6 steps ==
  in @/src/config.js
    replace 'retries: 3' with 'retries: 5'
  run_tests
--
10:42:01  replace  src/config.js                             undo saved
10:42:01  tool     run_tests
10:42:09  run      npm test                                  in a sandbox with local network, code 0, 7.9 s, from run_tests
```

TODO (Carson): every step goes to `.talk/audit/`, one file a day, kept for 3 days (`keep audit for 7 days` in `AGENTS.talk` keeps more). The agent cannot change it; `audit as json` for tools; `the audit` lets the agent read its own steps.

<h3 id="undo">Undo</h3>

```talk
undo
undo 3
undo changes to ./src/app.js
print the undo list
```

TODO (Carson): undo works across scripts in a session, and touches nothing that changed since; it covers file changes, not programs or commits.
<h2 id="harness-notes">Harness and Agent Notes</h2>

TODO (Carson): intro. Notes for specific harnesses and agents.

### Claude Code subagents

```bash
claude --tools "Agent" --strict-mcp-config --mcp-config .mcp.json --allowedTools mcp__clank-talk
```

TODO (Carson): subagent notes.

- Subagents get only the session's tools, so they get ClankTalk and nothing else.
- A custom subagent that lists `Glob` or `Grep` in its `tools:` gets them anyway: do not list them.
- Each subagent can pass its name as `agent`: it gets its own undo list and `$` variables, and the audit says who did what.

<h2 id="fine-print">The Fine Print</h2>

TODO (Carson): the honest limits.

- A `run` without `in a sandbox` is where the sandbox ends.
- The sandbox limits files and the network, not CPU or memory.
- On Linux, the sandbox protects hidden files and `.talk` files only at the top of the project, and only those that exist when the program starts.
- Web pages and tool output can try to steer your agent. ClankTalk keeps the damage small, but cannot stop the agent from believing what it reads.
- Secrets are safe only in `.env` files. A copy of a secret in another file is ordinary text that a script can read and change.
- `git push` to a remote folder outside the project runs that repo's hooks. A remote folder inside the project is refused.

</div>
