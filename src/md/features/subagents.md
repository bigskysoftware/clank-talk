# Subagents

A tool in AGENTS.talk can hand a task to a subagent: a model that can call only the tools a human named. Built: `run ... in a subagent`, `start ... in a subagent ... as`, the model from the harness or the API, the load checks, labels, the audit and the limits.

Code: `src/js/subagent.js` (the loop, and the Anthropic API over raw HTTP), `src/js/harnesses/pi-host.js` (pi lends its model), `src/js/runtime.js` (the commands and the checks).

## Syntax

- Approved (built): the subagent is a place to run, like a sandbox.

```talk
# Lists the open issues that match a query.
untrusted tool gh_issues with query
  run 'gh' with 'issue', 'list', '--search', query
end

# Summarizes the most important open issues.
tool summarize_gh_issues
  run 'Summarize the most important open GitHub issues' in a subagent with only gh_issues
end
```

- Approved (built): `start '<prompt>' as '<name>' in a subagent with only <tools>` runs the same subagent in the background, as a process. Why this order: every `start` names the process first, and says where it runs last, as in `start 'npm run dev' as 'site' in a sandbox`. A process: `process 'name'` has its status and, when it ends, its answer as `output`. `stop process` stops it. The answer is untrusted.
- Approved (built): a subagent takes a prompt only: `with` arguments or `using secret` on the same `run` are an error.

## The model

- Approved (built): MCP sampling is not an option: Claude Code does not support it, and the MCP spec deprecated it in 2026-07-28. ClankTalk runs the agent loop itself.
- Approved (built): the harness lends its model if it can. pi does, through `ctx.modelRegistry.complete`, with pi's own login: no key. With no `use model` line, the subagent uses pi's current model; `use model 'anthropic/claude-sonnet-5-5' for subagents` picks another model that pi knows.
- Approved (built): MCP harnesses (Claude Code, Codex, ...) cannot lend a model. There the subagent calls the Anthropic Messages API, over raw HTTP (no SDK, so no runtime dependency), with a key:

```talk
# AGENTS.talk
allow secret ANTHROPIC_API_KEY for subagents
use model 'claude-sonnet-5-5' for subagents with secret ANTHROPIC_API_KEY
```

- Approved (built): with neither, the `run` fails: `This harness (MCP) cannot lend its model to a subagent. Add a model and a key to AGENTS.talk: use model 'claude-sonnet-5-5' for subagents with secret ANTHROPIC_API_KEY`. The error comes at the run, not at load: the same AGENTS.talk can work in pi and fail in Claude Code.
- Approved (built): `use model ... with secret NAME` needs `allow secret NAME for subagents`, or the load fails. Only AGENTS.talk can have `use model`, once.
- Approved (built): the model host is trusted with the prompt and the tool results: they go to it with no `Send private data` question.

## How it runs

- Approved (built): the model sees a short system prompt from ClankTalk, the prompt from the `run` line, and the tools after `with only`: each with its `#` comment as the description, and its parameters as text inputs. No `tool_choice` is sent.
- Approved (built): the loop: the model calls tools, ClankTalk runs them, and all results for one turn go back in one message, until the model gives a final answer. The model's reply goes back unchanged, thinking blocks too.
- Approved (built): each tool call goes through the normal runtime: hooks, the audit (`from subagent <tool>`), the sandbox, secrets. A failed tool call goes back to the model as an error (`is_error`).
- Approved (built): limits: at most 20 tool calls; 5 minutes (`within` makes it shorter); the calls count against the step budget. A refusal, a reply that is too long, or an API error fails the `run`. The API is tried again on 429, 500 and 529, at most 2 times.
- Approved (built): a background subagent outlives the script that started it, so each of its tool calls runs as its own small script, with the host's options. The arguments go in `$` globals, never in the script text.

## Trust

- Approved (built): trust the actions, not the answer. The subagent's power comes only from the tools after `with only`. The arguments it sends get no labels, so its tool calls ask no taint questions.
- Approved (built): the answer gets every label the subagent saw (the prompt and the tool results), and always `untrusted` from `subagent <tool>`.
- Approved (built): a load check refuses a tool in a `with only` list if it writes files (`write`, `append`, `put`, line edits, `replace` in a file, `move`, `delete`), or uses `fetch`, `git`, `start`, or another subagent. `run` is left to the author: list only tools that are safe with any argument. A tool that posts, deletes or spends money must not be in a `with only` list.
- Approved (built): a tool in a `with only` list must be in AGENTS.talk.
- Approved (built): a policy can say `deny subagents`.

## Audit

- Approved (built): each tool call of a subagent is a `tool` step `from subagent <tool>`. A `subagent` step at the end counts the tool calls. A background subagent's tool calls are scripts of their own, with the agent name `subagent-<name>`.

## Later

- Generate Claude Code agent files from these tools (`.claude/agents/<tool>.md`, with a ClankTalk server limited to the `with only` tools), so the harness's own background agents run them, with its interface and its billing.
- A model for one tool.
- Server-side refusal fallbacks.
