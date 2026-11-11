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

/cc these instructions are different than the landing page  
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

### The AGENTS.talk File

An `AGENTS.talk` file lives in the root of your project and is loaded by the ClankTalk environment when it starts up and defines:

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

This `AGENTS.talk` file passes the `PATH` and `HOME` environment variables on to the programs that its tools run, and then defines a custom tool for running the tests in the project.

The `in a sandbox` part runs `npm test` in an OS sandbox.  In the sandbox, the program can write only to your project (not to `.git`, `.talk` files or hidden files), it can read only system folders, its install folder and tool caches, and it has no network.

The `with local network` part then gives the program `localhost`, so tests that start a local server still work.

The program still cannot get to the internet.

Agents can then execute the `run_tests` tool and read its output.

#### Finding AGENTS.talk

ClankTalk resolves the project root to look for `AGENTS.talk` in the following order:

1. `--root /path/to/project`, if you start the MCP server with it.
2. The environment variable `CLANK_TALK_ROOT=/path/to/project`.
3. The folder where your agent starts.

Note that agents cannot modify any `.talk` files in your project, so they are a protected space for you to write permissions and tools for them.

<h3 id="tools">A Tool for Running A Single Test</h3>

Running the entire test suite is great, but sometimes you only want to run a single test.  Or, at least, you only want your agent to run a single test.

Let's add another tool to run a single test:

```talk AGENTS.talk
# Runs one test file.
tool run_test_file with file
  run 'node' with '--test', file in a sandbox
end
```

Your agent can can call this new tool with a file:

```talk
set tests to run_test_file @/test/app.test.js
if tests's code is not 0
  print find 'FAIL' in tests's output
end
```
The `@/test/app.test.js` path is a _project relative_ path (don't worry, your agent will figure it out.)

Note that an agent can *never* execute `run` directly, only via the tools that you give it in an `AGENT.talk` file.  The agent can't use shell and the execution passes in only the variables in `allow env`.

This gives you significant control over what an agent is and is not allowed to do in your project.

### Dealing With Hanging Tests

Now let's go back and improve the `run_tests` tools.

Let's say that it is prone to hanging at times and we don't want our tool to wait forever when it does.

We can add `within 2 minutes` to the end of our `run` and it will kill a hung test.

```talk AGENTS.talk
# Runs the full test suite.
tool run_tests
  run 'npm test' in a sandbox with local network within 2 minutes
end
```

Agent can set shorter limit on a tool call: `run_tests within 2 minutes` as well.

<h3 id="sandboxing">Accessing A Cache Outside the Project</h3>

By default, ClankTalk runtime file access is _sandboxed_ to the current project directory and subdirectories.  

This is not a fool-proof sandbox in the strict sense, but a best-effort "prevent agents from messing with stuff" mechanism.

Of course, sometimes you might need to give tools access to a directory (e.g. a playwright cache).  

You can do this in your `AGENTS.talk` tool definitions like so:

```talk AGENTS.talk
# Runs the full test suite.
tool run_tests
  run 'npm test'
    in a sandbox with local network, reads of '~/.cache/ms-playwright'
    within 10 minutes
end
```

### Fixing the CI Config

Another CatTalk default is that agents are not allowed to change hidden files.  

This prevents rogue agents from changing dangerous files like `.git/hooks/pre-commit`, a script that git runs on your machine at your next commit.

Sometimes, though, you want to allow an agent to modify hidden files like your CI config in `.github/`.  

To do so, you can use the `allow changes` syntax in your AGENTS.talk file:

```talk AGENTS.talk
allow changes to @/.github/
```

Note that ClankTalk *never* allows agent changes to `.talk` files and also bans all reading and writing of `.env`, `.env.*` and `.envrs` files in any folders.

### The Dev Server

Next, let's give our agent the ability to start a dev server for us by executing an NPM command, `npm run dev`

This is not a synchronous task, instead you want to be able to launch it and then continue working.  

For something like that, you can use `start`

```talk AGENTS.talk
allow fetch from http://localhost:5173/

# Starts the dev server.
tool dev_server
  start 'npm run dev' as 'dev' in a sandbox with local network
end
```

Note that we allow `fetch` from `http://localhost:5173` explicitly: we don't want to give agents the ability to just spam our machine looking at ports, now do we?  By default, fetches will be disallowed.

Your agent can then start it, and, if it wants, wait for it to come up:

```talk
dev_server
wait until (fetch http://localhost:5173/ as response)'s status is 200 
  within 15 seconds
print the output of process 'dev'
```

The agent can then stop the process with `stop`:

```talk
stop process 'dev'
```


### Installing Packages

OK, let's add another tool to, *sigh*, install NPM pacakges.

`npm install` needs the wider network obviously, and also needs access to npms cache directory.

To give it access to that we would write:

```talk AGENTS.talk
# Installs the dependencies.
tool npm_install
  run 'npm install' in a sandbox with network, writes to '~/.npm'
end
```
We give the `npm_install` tool the minimal set of permissions it needs.

<h3 id="secrets">Calling the GitHub API</h3>

Sometimes you need _secrets_ in a project.  Of course, secrets are dangerous because they can leak.

ClankTalk uses the `.env` convention for secrets, and refuses to let scripts read or write `.env` files.

Secrets are resolved in the following way:

* First, the environment that ClankTalk runs in.
* Then `.env.local`, in the project root.
* Then `.env`, in the project root.

An empty value counts as no value.  ClankTalk reads the files on each script run, so changes are picked up immediately.

The files use the usual dotenv form: `KEY=value` lines, `#` comments, an optional `export`, and quoted values.

Scripts cannot read `.env`, `.env.*` or `.envrc` files in any folder, and `git diff` and `git show` hide their contents.

ClankTalk loads only the secrets that an `allow secret` line specifies in your AGENTS.talk file:

```talk AGENTS.talk
allow fetch from 'api.github.com'
allow secret GITHUB_TOKEN for fetch to 'api.github.com'
```

With this line, your agent can then use the token when fetching from Github.

However, it cannot see its value.

```talk
fetch https://api.github.com/user as json
  with headers: {
    Authorization: 'Bearer ' + secret GITHUB_TOKEN
  }
```

### Publishing to npm

OK, now let's say we want our agent to publish our package to npm.

To publish, `npm` needs a token in its environment.  We don't want the agent to ever see that token, so we give it to the tool rather than to the agent:

```talk AGENTS.talk
allow secret NPM_TOKEN for run

# Publishes the package.
tool publish
  run 'npm publish' using secret NPM_TOKEN in a sandbox with network
end
```

The `using secret NPM_TOKEN` bit hands the token to `npm` as an environment variable.  If the token ever shows up in the output, ClankTalk replaces it with `<secret NPM_TOKEN>`.

Now, a word of warning: a program with a secret and the network can send that secret anywhere it likes.  And `npm publish` runs scripts from `package.json`, a file your agent can happily edit.  So be careful about handing secrets to programs whose code your agent can change!

ClankTalk is here to help, but it's not omnicient!

<h3 id="hooks">Hooks</h3>

Let's say you want a global rule that every program your agent runs must be in a sandbox.  

You *could* write that down in your `AGENTS.md` and hope for the best but, agents being agents, sooner or later one will forget.

What you really want is a way to verify on every run that the run is in a sandbox.

That's what hooks are for: they let you hook into before and after runtime calls to, well, pretty much anything, and potentially stop what's going on.

Here is a hook that rejects any `run` that isn't in a sandbox:

```talk AGENTS.talk
before run
  if the run's sandbox is null
    reject 'Use a sandbox'
  end
end
```

A `before` hook runs before every step of its kind.  If the hook calls `reject`, the step doesn't happen, and the script gets your message back as an error.

You can hook into pretty much anything an agent does:

| Step          | Runs before                                                                     |
|---------------|---------------------------------------------------------------------------------|
| `read`        | a script reads a file                                                           |
| `write`       | a script writes a file                                                          |
| `append`      | a script adds text to the end of a file                                         |
| `replace`     | a script replaces text in a file                                                |
| `put`         | a script puts lines into a file                                                 |
| `remove`      | a script removes lines from a file                                              |
| `move`        | a script moves a file                                                           |
| `delete`      | a script deletes a file                                                         |
| `undo`        | a script puts files back with `undo`                                            |
| `change`      | any file change at all: all of the above except `read`                          |
| `run`         | a tool runs a program                                                           |
| `start`       | a tool starts a background program                                              |
| `stop`        | a script stops a background process                                             |
| `git`         | any git command                                                                 |
| `fetch`       | a fetch from a URL                                                              |
| `<tool name>` | a call to one of your own tools: `the <tool name>'s <parameter>`                |

There are also `after` hooks.  An `after` hook runs once the step is done, and `the result` is whatever the step gave back.

Note that a hook can't change the step it is looking at, and it can't run a program, not even through a tool.  

Hooks say yes or no, and that's it.

### Ask Me Before a Push


A git push is (often) public and can be an egress mechanism for external communication, one leg of the [lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/).

Let's say you want your agent to ask you before it pushes anything, so you can be sure.

Here's a hook to accomplish that:

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

The `ask` command is special: only a human can answer it and the agent can't get around it.

If you wander off and don't answer within 2 minutes, the result is `null`, which means no.

#### Git In ClankTalk

Note that the git in ClankTalk is already reasonably locked down:

* `commit` takes only the files you name
* `merge` only fast-forwards
* `rebase` is all or nothing
* `push` sends the current branch and never uses force
* Git hooks, pagers and filters are all turned off

Also, if your project is a subfolder of a bigger repo, `git status`, `diff`, `show` and `log` only cover your project

### Keeping Agents Out of Migrations

Maybe your company has a policy that all database migrations, found in `/migrations/` must be written by humans.  (Fair!)

You could enforce this policy with the following hook:

```talk AGENTS.talk
before change
  if the change's path is in @/migrations/
    reject 'A human writes the migrations'
  end
end
```

Note that `change` covers every sort file change: write, append, replace, line edits, move, delete and undo.

### Deploys

Let's say you're OK with your agent deploying to staging whenever it likes. (Brave!)

Production, however, is a bit much, and you'd like to be asked.

Here's a `deploy` tool that asks you before any deploy to prod:

```talk AGENTS.talk
# Deploys the app: staging or prod.
tool deploy with target
  if target is 'prod'
    ask 'Hey boss, deploy to prod?' with 'yes' or 'no'
    if the result is not 'yes'
      reject 'Not today, robot'
    end
  end
  run 'fly' with 'deploy', '--app', 'shop-' + target in a sandbox with network
end
```

A `reject` in a tool stops the tool, and your agent gets the message back as an error.

Now, if the rule lives somewhere else, say in a team policy, you can also hook into *your own tools*, not just the built-in steps.  Inside the hook, each parameter goes by its own name:

```talk AGENTS.talk
before deploy
  if the deploy's target is 'prod'
    reject 'Prod deploys go through CI'
  end
end
```

By the way, that `'shop-' + target` might make you a little itchy around injection attacks, but `run` *never* goes through a shell.  

Each value after `with` goes to `fly` as exactly one argument, so a strange `target` can only change the app name.  It can't sneak in a new flag or a second command.

### Less Test Output

Test runners typically output tremendous amounts of text.  A failing suite can easily dump thousands of lines on your agent, eating up context.

In ClankTalk, you can trim the output of a chatty programs when you run it, using the `keeping` clause:

```talk AGENTS.talk
tool run_tests
  run 'npm test' in a sandbox keeping the last 200 lines
end

tool lint
  run 'npx eslint .' in a sandbox keeping lines matching pattern /error/
end
```

You can keep `the first <n> lines`, `the last <n> lines`, both, or only `lines matching` a pattern.  

ClankTalk puts a single line like `... 1834 lines cut ...` where the rest used to be.  You can add `or 20 KB` to any of these to cap the size, too.

Nothing is lost, though: the result's `full` has every line, so your agent can dig in if it really needs to.

The same `keeping` works for everything a script prints, with a line at the top of `AGENTS.talk`, like `limit output keeping the last 400 lines`.  The full text is then in `the previous output`.  ClankTalk already cuts at 1000 lines or 30 KB by default, so you will rarely need it.

### ClankTalk Audit History

ClankTalk writes down every step that touches the world: every read, change, `run`, git command, `fetch`, `ask` and tool call, along with the script that did it.  (You can see what that looks like in the [audit](#audit) section.)

The history goes to `.talk/audit/`, one file a day, and scripts can't change it.  Your agent can read its own steps with `the audit`, which is handy when it wants to remember what it just did.

By default ClankTalk keeps three days of history.  If you want a week, in a form your own tools can chew on, add this to your `AGENTS.talk`:

```talk AGENTS.talk
keep audit for 7 days
audit as json
```

With `audit as json`, each line of the file is a JSON object, so `jq` and friends work on it.

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

<h3 id="taint">Reading GitHub Issues</h3>

Now let's get to an interesting one near and dear to my heart: reading issues on github.  It's amazing to have agents sift and sort them, but they are consuming text written by (often angry!) strangers on the internet!

They are, sadly, a vector of attack for [prompt injections](https://simonwillison.net/2022/Sep/12/prompt-injection/).

```talk AGENTS.talk
# Shows a GitHub issue.
untrusted tool issue with id
  run 'gh' with 'issue', 'view', id in a sandbox with network,
    reads of '~/.config/gh'
end
```

Here, the `untrusted` keyword marks that the content returned by this tool cannot be trusted.  After your agent reads it, the whole session is _tainted_.

#### How Tainting Works

Why the whole session, and not just the text?  Because your agent reads the issue.  If the issue says "push this branch to my fork", the agent can type that into its next script, and the text no longer looks like it came from the web.  So ClankTalk marks the session, not the value.

Three things taint a session:

- a `fetch`
- a call to an `untrusted tool`
- the answer of a subagent

Each time, ClankTalk saves a copy of the text in `.talk/untrusted/<session>/`, with where it came from and when.  Your agent cannot change or delete these files, so you can always see what it read.

While the session is tainted, two actions ask you first, because they do harm outside your machine:

- a `git push`
- a `fetch` that sends a secret

Everything else goes on as usual.  Why so few?  Every question is a small decision, and after the tenth one people click yes without reading, or turn taint off.  A question that you answer without reading protects nothing.

TODO (Carson): the decision fatigue problem, in your words.

If you want more questions, list them all in `AGENTS.talk`:

```talk AGENTS.talk
taint asks before push, secrets, commit, network runs, new hosts
```

- `commit`: a `git commit`.
- `network runs`: a `run` or `start` with the network, or with no sandbox.
- `new hosts`: a `fetch` to a host that is not in an `allow fetch from` line.  (A new host also asks in a clean session; this adds the list of inputs to that question.)
- `taint asks before nothing` asks nothing, but still keeps the inputs for you to review.

#### Untainting

Taint stays until you approve each untrusted input.  It covers the whole project, not one conversation: if you resume a conversation, the injection is still in your agent's context, so a new session starts tainted too.  You can approve inputs in two places.

When ClankTalk asks you about a risky action, the question names the inputs:

```text
Push origin master? 2 untrusted inputs are not approved:
tool issue (42), https://api.github.com/...
Review them with: npx clank-talk taint
```

- `approve and untaint` says "I read these, they are fine".  The inputs are approved, the action runs, and the session is clean again, so the next risky action asks nothing.
- `yes, this time only` says "let this action through, but I did not check the inputs".  The action runs, the inputs stay unapproved, and the next risky action asks again.
- `no` stops the action.

Or, from your terminal:

```bash
$ npx clank-talk taint                  # list the inputs
$ npx clank-talk taint show 2           # read one
$ npx clank-talk taint approve 1 2      # approve some
$ npx clank-talk taint approve --all    # approve all
```

Your agent has no shell in ClankTalk, so it cannot run these commands.

If you do not want to read every input yourself, a _judge_ model can read them for you and say `clean`, `suspect` or `unsure`:

```bash
$ npx clank-talk taint judge --all
$ npx clank-talk taint approve --clean
```

The judge reads the same text as your agent, so an injection can fool it too.  Its verdict is advice, unless you say otherwise.

#### Configuration

```talk AGENTS.talk
# on (the default), off, or required: required means no one can turn it off
taint required

# how much of each input to keep for review (1 MB by default)
keep untrusted inputs up to 5 MB

# the judge: its model, when it runs, and what it may do
use model 'claude-haiku-5-5' for judging with secret ANTHROPIC_API_KEY
allow secret ANTHROPIC_API_KEY for subagents
judge untrusted inputs automatically
let the judge approve clean inputs
```

- `npx clank-talk taint off` and `npx clank-talk taint on` change the setting from your terminal.  They win over `taint on` and `taint off`, but not over `taint required`.
- `judge with prompt '...'` replaces the prompt of the judge.
- A team policy can hold `require taint`, which works like `taint required`.
- A program with no sandbox runs as you, so it can change `.talk/`.  ClankTalk checks `.talk/` after each such `run`, and stops the script if something changed.

### No Programs After Web Text

TODO (Carson): the problem: after your agent reads an issue, you do not want it to run programs at all, not even with a question.

```talk AGENTS.talk
before run
  if the session is untrusted
    reject 'No programs after web text'
  end
end
```

- A hook can check `the session is untrusted`, and list `the session's untrusted inputs`.

### The Whole File

TODO (Carson): all of it together. The order: `allow`, `use model`, `limit` and `keep audit` lines at the top, then imports and tools, then hooks. Hooks run in the order that you write them.

```talk AGENTS.talk
allow env PATH, HOME
allow fetch from http://localhost:5173/, 'api.github.com'
allow changes to @/.github/
allow secret GITHUB_TOKEN for fetch to 'api.github.com'
allow secret NPM_TOKEN for run
allow secret ANTHROPIC_API_KEY for subagents
use model 'claude-sonnet-5-5' for subagents with secret ANTHROPIC_API_KEY
limit output keeping the first 200 and the last 200 lines
keep audit for 7 days
audit as json

# issue and summarize_issues
import ./talk/github.talk

# Runs the full test suite.
tool run_tests
  run 'npm test'
    in a sandbox with local network, reads of '~/.cache/ms-playwright'
    within 10 minutes
end

# Runs one test file.
tool run_test_file with file
  run 'node' with '--test', file in a sandbox
end

# Starts the dev server.
tool dev_server
  start 'npm run dev' as 'dev' in a sandbox with local network
end

# Installs the dependencies.
tool npm_install
  run 'npm install' in a sandbox with network, writes to '~/.npm'
end

# Publishes the package.
tool publish
  run 'npm publish' using secret NPM_TOKEN in a sandbox with network
end

# Deploys the app: staging or prod.
tool deploy with target
  if target is 'prod'
    ask 'Deploy to prod?' with 'yes' or 'no'
    if the result is not 'yes'
      reject 'Only a human can approve a prod deploy'
    end
  end
  run 'fly' with 'deploy', '--app', 'shop-' + target in a sandbox with network
end

before run
  if the run's sandbox is null
    reject 'Use a sandbox'
  end
  if the session is untrusted
    reject 'No programs after web text'
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
  if the change's path is in @/migrations/
    reject 'A human writes the migrations'
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
claude --tools "Agent" \
  --strict-mcp-config --mcp-config .mcp.json \
  --allowedTools mcp__clank-talk
```

TODO (Carson): subagent notes.

- Subagents get only the session's tools, so they get ClankTalk and nothing else.
- A custom subagent that lists `Glob` or `Grep` in its `tools:` gets them anyway: do not list them.
- Each subagent can pass its name as `agent`: it gets its own undo list and `$` variables, and the audit says who did what.

<h2 id="fine-print">The Fine Print</h2>

TODO (Carson): the honest limits.

- A `run` without `in a sandbox` is where the sandbox ends.
- The sandbox limits files and the network, not CPU or memory.
- On Windows, there is no sandbox yet: `in a sandbox` is an error. To use the sandbox, run your agent and ClankTalk inside WSL2, where the Linux sandbox (`bubblewrap`) works. WSL1 does not work.
- On Linux, the sandbox protects hidden files and `.talk` files only at the top of the project, and only those that exist when the program starts.
- Web pages and tool output can try to steer your agent. ClankTalk keeps the damage small, but cannot stop the agent from believing what it reads.
- Secrets are safe only in `.env` files. A copy of a secret in another file is ordinary text that a script can read and change.
- `git push` to a remote folder outside the project runs that repo's hooks. A remote folder inside the project is refused.

</div>
