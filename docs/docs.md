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
<li><a href="#limitations">Limitations</a></li>
</ul>

<div class="construction">

ClankTalk is under construction!

</div>

## Overview {#overview}

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

## Install {#install}


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
<li role="option" tabindex="0" data-agent="cursor"><span class="agent-icon cursor">C</span>Cursor</li>
<li role="option" tabindex="0" data-agent="codex"><span class="agent-icon codex">O</span>Codex</li>
<li role="option" tabindex="0" data-agent="pi"><span class="agent-icon pi">&pi;</span>pi</li>
<li role="option" tabindex="0" data-agent="other"><span class="agent-icon other">M</span>Other MCP clients</li>
</ul>
</div>
</div>

<div class="harness" data-agent="claude">

### Claude Code

Add the server:

```bash
$ claude mcp add clank-talk -- npx -y -p clank-talk@0.1 clank-talk-mcp
```

Then start Claude Code with ClankTalk as its only tool:

```bash
$ claude --tools "" --allowedTools mcp__clank-talk
```

<aside>

To share the server with your team, put it in a `.mcp.json` at the root of your project instead:

```json
{
  "mcpServers": {
    "clank-talk": {
      "command": "npx",
      "args": ["-y", "-p", "clank-talk@0.1", "clank-talk-mcp"]
    }
  }
}
```

</aside>

</div>

<div class="harness" data-agent="cursor" hidden>

### Cursor

Save this as `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "clank-talk": {
      "command": "npx",
      "args": ["-y", "-p", "clank-talk@0.1", "clank-talk-mcp"]
    }
  }
}
```

</div>

<div class="harness" data-agent="codex" hidden>

### Codex

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.clank-talk]
command = "npx"
args = ["-y", "-p", "clank-talk@0.1", "clank-talk-mcp"]
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

Most MCP clients take a config like this:

```json
{
  "mcpServers": {
    "clank-talk": {
      "command": "npx",
      "args": ["-y", "-p", "clank-talk@0.1", "clank-talk-mcp"]
    }
  }
}
```

If your client lets you, turn off its other tools, so the agent uses ClankTalk for everything.

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


## Your AGENTS.talk {#agents-talk}

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

### A Tool for Running A Single Test {#tools}

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

### Accessing A Cache Outside the Project {#sandboxing}

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
wait until the status of fetch http://localhost:5173/ as response
  is 200 within 15 seconds
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

### Calling the GitHub API {#secrets}

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

### Hooks {#hooks}

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

Note that `change` covers every sort file change: write, append, replace, line edits, move, delete and undo.  It also covers git commands that change files, like `git merge` or `git stash`, and a move into the folder, not just out of it.

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

### ClankTalk Audit History {#audit}

ClankTalk writes down every step that touches the world: every read, change, `run`, git command, `fetch`, `ask` and tool call, along with the script that did it.  You can watch it live:

```bash
tail -f .talk/audit/*.log
```

```audit
-- session claude-code-4f2a --
== 10:42:01  script 12  Raise the retries  (done, 4 steps) ==
  in @/src/config.js
    replace 'retries: 3' with 'retries: 5'
  run_tests
--
10:42:01  replace  src/config.js                             1 match, line 12
10:42:01  tool     run_tests
10:42:09    run    npm test                                  sandbox, local network, code 0, 7.9 s
```

The history goes to `.talk/audit/`, one file a day, and scripts can't change it.  Your agent can read its own steps with `the audit`, which is handy when it wants to remember what it just did.

By default, ClankTalk keeps three days of history.  

If you wanted to keep a week, you could add this to your `AGENTS.talk`:

```talk AGENTS.talk
keep audit for 7 days
audit as json
```

Adding `audit as json` turns each line of the file is a JSON object, so `jq` and friends can work with them.

### Sharing Tools

Once you have a nice set of GitHub tools, you'll probably want them grouped together and maybe moved out of your `AGENTS.talk` file.

You can put them in their own `.talk` file and import it:

```talk AGENTS.talk
import ./talk/github.talk
```

Note that a `./` path starts from the file doing the importing and `@/` starts from the project root.

Just like `AGENTS.talk`, your agent can't change anything in `talk/`, or any `.talk` file for that matter, so your shared tools stay safe.

### Taint & Reading GitHub Issues {#taint}

OK, now we are going to cover a feature that, I'm going to be honest, I'm not 100% sure on: tainting.

Tainting has a long history in programming languages.  Perl's [taint mode](https://perldoc.perl.org/perlsec), for example, won't let data from outside the program, like command line arguments or environment variables, reach a shell command or a file write until you check it with a regular expression.

I am trying to come up with something similar around [prompt injection](https://simonwillison.net/2022/Sep/12/prompt-injection/), and this is my current thinking on the problem.

Let's motivate the discussion with an interesting use of agents near and dear ot my heart: sifting through issues on github.

Before we get into ClankTalk's tain infrastucture, let's set up a _subagent_ with a restricted tool set to do github issue analysis for us:

```talk AGENTS.talk
allow secret ANTHROPIC_API_KEY for subagents
use model 'claude-sonnet-5-5' for subagents with secret ANTHROPIC_API_KEY

# Shows a GitHub issue.
untrusted tool issue with id
  run 'gh' with 'issue', 'view', id in a sandbox with network,
    reads of '~/.config/gh'
end

# Summarizes the most important open issues.
tool summarize_issues
  run 'Summarize the most important open issues' in a subagent with only issue
end
```

A subagent is a separate model that can only call the tools you give it.  Here, the subagent can call `issue` and nothing else, and the tools you give a subagent can't write files, fetch or use git.  

So even if a prompt injection happens in an issue and talks the subagent into something, there isn't much it can do.

<aside>

In pi, a subagent uses pi's own model, so you don't need a key.

</aside>

Don't get too comfortable with the subagent, though: it read the public issues, so its answer to the calling
agent untrusted too.  It *taints* your session just like the issues would: yes, it's harder to pull off, but
still possible.

After your agent reads the sub-agents response, the whole session is _tainted_.


#### How Tainting Works

Three things can taint a ClankTalk session:

- a `fetch`
- a call to an `untrusted tool`
- the answer of a subagent

Each time, ClankTalk saves a copy of the text in `.talk/untrusted/<session>/`, with where it came from and when.  
Your agent cannot change or delete these files, so you can always see what it read.

By default, while your session is tainted, two actions require confirmation:

- a `git push`
- a `fetch` that sends a secret

There are of course other actions that can potentially compromise you, and you can add them to taint checking:

```talk AGENTS.talk
taint asks before push, secrets, commit, network runs, new hosts
```

where:

- `commit`: a `git commit`.
- `network runs`: a `run` or `start` with the network, or with no sandbox.
- `new hosts`: a `fetch` to a host that is not in an `allow fetch from` line.  (A new host also asks in a clean session; this adds the list of inputs to that question.)

For anything else, a hook can check `the session is untrusted` itself:

```talk AGENTS.talk
before deploy
  if the session is untrusted
    reject 'No deploys after reading untrusted text'
  end
end
```

A hook can also list `the session's untrusted inputs`, if you want to say which ones are in the way.

Now, why is the default to only ask on `push` and `fetch`?

Because of the well known psychological problem of [decision fatigue](https://en.wikipedia.org/wiki/Decision_fatigue).  

We are trying to balance security with usefulness of this features, so people actually use it.  We'll see how it goes.

#### Untainting

Taint stays until you approve the untrusted input.  It covers the whole project, not one conversation: if you resume a conversation, the injection is still in your agent's context, so a new session starts tainted too.  

You can approve inputs in three places.

When ClankTalk asks you about a risky action, the question gives the untrusted content:

```text
Push origin master? 2 untrusted inputs are not approved:
tool issue (42), https://api.github.com/...
Review them with: npx clank-talk taint
```

- `approve and untaint` says "I read these, they are fine".  The inputs are approved, the action runs, and the session is clean again, so the next risky action asks nothing.
- `yes, this time only` says "let this action through, but I did not check the inputs".  The action runs, the inputs stay unapproved, and the next risky action asks again.
- `no` stops the action.

You can also use your terminal to look at tainted content:

```bash
$ npx clank-talk taint                  # list the inputs
$ npx clank-talk taint show 2           # read one
$ npx clank-talk taint approve 1 2      # approve some
$ npx clank-talk taint approve --all    # approve all
```

Your agent has no shell in ClankTalk, so it cannot run these commands.

Or, without leaving your harness, ask your agent to run `taint review`.  It shows you a form with a table of the inputs that are not approved, and a box to approve each one.  Only you can fill in the form.

<aside>

In Claude Code, you can show the taint state in your status bar with `npx clank-talk taint --line`, which prints `taint off`, `untainted` or `tainted <n>`.

</aside>

#### LLM Judging

If you do not want to read every input yourself you can use a _judge_ model can read them for you and say `clean`, `suspect` or `unsure`:

```bash
$ npx clank-talk taint judge --all
$ npx clank-talk taint approve --clean
```

Note that the judge reads the same text as your agent, so a prompt injection attack can fool it too.

#### Configuration

Here are all the configuration options for taint:

```talk AGENTS.talk
# on (the default), off, or required: required means no one can turn it off
taint required

# how much of each untrusted input to keep for review (1 MB by default)
keep untrusted inputs up to 5 MB

# the judge: a model that reads each input, and says clean, suspect or unsure
use model 'claude-haiku-5-5' for judging with secret ANTHROPIC_API_KEY

# the judge needs the key, as a subagent does
allow secret ANTHROPIC_API_KEY for subagents

# judge each new input when it comes in (else: npx clank-talk taint judge)
judge untrusted inputs automatically

# a clean verdict approves the input, so you get no question for it
let the judge approve clean inputs
```

- `npx clank-talk taint off` and `npx clank-talk taint on` change the setting from your terminal.  They win over `taint on` and `taint off`, but not over `taint required`.
- `judge with prompt '...'` replaces the prompt of the judge.
- A [team policy](policy.html) can hold `taint required` too.

### Creating An Agents.talk File

A `AGENTS.talk` file is declared in the following order:

1. The top lines: `allow`, `use model`, `limit`, `keep audit` and `taint`
2. Imports and tools
3. Hooks, which run in the order you write them

See the [AGENTS.talk reference](agents-talk.html) for more details.

A suggested prompt for a non-ClankTalk agent to generate an `AGENTS.talk` is:

```md
Read <link> and walk me through creating an AGENTS.talk file for this project
```

### Policies for Teams

If you're running agents for a team, you probably want some rules that individual projects can't loosen.  That's what a policy is for: a file that ships with the harness and sets limits no `AGENTS.talk` can widen.

See [Policies for Teams](policy.html) for the details.

## Reading ClankTalk {#reading-output}

We don't expect you to write much ClankTalk, but you are going to probably want to read some of it.  We hope that it's pretty obvious what's going on, at least when compared with, say, bash.

Still, probably worth a quick tour of the language:

- `#` starts a comment, and blocks close with `end`.
- `the` is optional, and `robot's name`, `robot.name` and `the name of robot` all mean the same thing.
- `it` (or `the result`) is whatever the last command gave back.
- `@/` paths start at the project root, and `./` paths at the current folder.
- Lines that start with `|` are text, exactly as typed, usually code.

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

If you run into something you don't recognize, every command is in the [Docs for Agents](reference.html).

### Questions From ClankTalk

ClankTalk will occasionally stop to ask you something.  You get a question when:

- Your agent fetches from a host for the first time (unless an `allow fetch from` line covers it)
- Your session is tainted and your agent tries something on the `taint asks before` list, like a push
- A hook asks you, with `ask`
- Your agent asks you directly, also with `ask`

### Undo {#undo}

The ClankTalk runtime maintains an undo list of all operations it has seen, so either an agent or you, the human,
can request that changes be undone.

Here is an example of an agent making a change, running a test and, if the test fails, undoing the change:

```talk
in ./src/config.js replace 'retries: 3' with 'retries: 5'
run_test_file @/test/config.test.js
if the result's code is not 0
  undo
  print 'The test failed, so the change is undone'
end
```

## Harness and Agent Notes {#harness-notes}

<div class="construction">

Work in progress

Notes for specific harnesses and agents are coming soon.

</div>

## Limitations {#limitations}

I hope that ClankTalk is a step forward in providing a safer environment for agents to work in.  It can feel
a little constricting at first when you initially build out your `AGENTS.talk` file, but that's probably a good thing.

That being said, ClankTalk isn't foolproof:

- A `run` without `in a sandbox` is where the sandbox ends.
- The sandbox limits files and the network, not CPU or memory.
- On Windows, there is no sandbox yet: `in a sandbox` is an error. To use the sandbox, run your agent and ClankTalk inside WSL2, where the Linux sandbox (`bubblewrap`) works. WSL1 does not work.
- On Linux, the sandbox protects hidden files and `.talk` files only at the top of the project, and only those that exist when the program starts.
- Web pages and tool output can still try to steer your agent. ClankTalk tries to keep the damage contained, but cannot stop a sufficiently determined and corrupted agent.
- Secrets are safe only in `.env` files.  If they end up in other spots, they can be compromised.
- `git push` to a remote folder outside the project runs that repo's hooks.

And there are probably holes in the implementation as it stands.  We'll try to get them patched up, but we think the basic idea is sound.

Hope it helps!

</div>
