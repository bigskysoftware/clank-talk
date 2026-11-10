# Ask

Approved.

`ask` puts a question to the human, and waits for the answer. Hooks use it for approvals, for example before a push.

## Who answers

- Approved: only the human answers. The question never goes to the agent, because an agent could answer its own question with "yes".
- Approved: the host shows the question. In the MCP host, this is MCP elicitation (`elicitation/create`), if the client supports it.
- Approved: if the host cannot ask the human, `ask` gives `null`. A hook must treat `null` as "no". Thus, with no human, nothing that needs approval happens.

## Syntax

From hyperscript: `ask <question>` gives the text that the user types, and `answer <message> with <a> or <b>` gives the choice.

- Approved: `ask <question>`. The result is the text that the human types, or `null`.
- Approved (built): a file in the question or the choices is its path, as in `+` and `${}`. To show its text, write `ask file's text`. Before, `ask ./plan.md` showed the text of the file.
- Approved: `ask <question> with <a> or <b>`. The human picks one. The result is the choice, or `null`. Here `or` is claimed (the follows set), so it is not the logic `or`.
- Approved: `ask` works in scripts, tools and hooks.
- Approved: a time limit, as for tools: `ask 'Push?' with 'yes' or 'no' within 5 minutes`. With no answer in time, the result is `null`.

Example, an approval in AGENTS.talk:

```talk
before git
  if the git's operation is 'commit'
    ask 'Commit ' + the git's files + '?' with 'yes' or 'no'
    if the result is not 'yes'
      reject 'The human said no'
    end
  end
end
```

## Hosts

- Approved (built): the runtime gets `options.ask`, an async function `({ question, choices, signal }) => text or null`. With no `options.ask`, the result is `null`.
- Approved (built): the MCP host uses elicitation (`elicitation/create`) if the client declares `capabilities.elicitation` at `initialize`. The schema has one string field, `answer`, with an `enum` for choices. `accept` gives the answer. `decline`, `cancel` or no answer gives `null`.
- Approved (built): an answer that is not one of the choices is `null`. A host that fails to ask gives `null`.
- Approved (built): with no `within`, a question waits at most 2 minutes (`options.askTimeLimit` can change it). This holds for `ask` and the fetch approval. Why: a client that cannot show the dialog, for example on a phone, must not hang the script. No answer in time is `null`, so no. The error for fetch says "nobody answered in time", and the audit says "no answer within 120 s".
- Claude Code supports elicitation (its MCP docs, "Respond to MCP elicitation requests"). Tested by hand on 2026-11-09: the dialog showed the question with the two choices, and the human's pick came back as the result.
- Note: Claude Code has an `Elicitation` hook that can answer with no dialog. It is in `.claude/` settings, which scripts cannot change, because hidden files are refused.
