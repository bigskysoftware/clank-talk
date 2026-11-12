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
- Approved (built, 2026-11-11): a choice can hold a description after `: `: `ask 'Deploy where?' with 'staging: the test site' or 'production: the live site'`. The human sees all of the text. The result is the text before the first `: ` (`staging`). Only a colon with a space after it splits, so `'http://x'` stays whole. Why: no new syntax. Rejected: `'staging' meaning 'the test site'`, and a list of objects.
- Approved (built, 2026-11-11): `ask <question> with any of <a> or <b> ...` lets the human pick several. The result is a list of the choices (their values), in the order of the choices. None picked is an empty list, so `for file in it` works. `null` stays for no answer. Rejected: `with some of`, and a separate `choose` command.
- Approved (built, 2026-11-11): the first choice is the default: a form shows it chosen at the start, and the Claude Code dialog starts on it. With `any of`, no choice is ticked at the start. A time limit or a cancel gives `null`, never the default. Why: the mod dialog cannot start on another choice, and a script must not get a choice that the human did not make. Rejected: a `default` word.

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

- Approved (built): the runtime gets `options.ask`, an async function `({ question, choices, signal }) => text or null`. With `any of`, it also gets `many: true`, and gives a list of choices. With no `options.ask`, the result is `null`.
- Approved (built): the MCP host uses elicitation (`elicitation/create`) if the client declares `capabilities.elicitation` at `initialize`. The schema has one string field, `answer`, with an `enum` for choices. `accept` gives the answer. `decline`, `cancel` or no answer gives `null`.
- Approved (built, 2026-11-11): the schema has titled choices (`oneOf` with `const` and `title`, both the full text) and the first as `default`. With `any of`, `answer` is an array (`items.anyOf`), not required. When the script stops asking (a time limit, or the end of the script), the server sends `notifications/cancelled`, so the client closes its dialog. Tested in Claude Code 2.1.322: titles, multi-select boxes, defaults and the cancel work. The human found the form hard to use: a list starts closed, then Space, then Accept.
- Approved (built, 2026-11-11): the Claude Code plugin `clank-talk` (folder `src/js/harnesses/claude-code/`, moved there from `claude-code/` on 2026-11-11; marketplace `.claude-plugin/marketplace.json` at the root) shows a question in Claude Code's own question dialog: numbered choices, Enter picks. Its `classic.Elicitation` hook reads `x-clank` in the schema: a one-time token and a `http://127.0.0.1:<port>/answer` URL. It asks with `$.ui.ask`, posts `{ token, answer }` there, and blocks the built-in form, which Claude Code then declines. The server takes the first of the two answers, and each token works once. Only for a client named `claude-code` and 2 to 4 choices, because the dialog takes at most 4 and other clients can refuse an unknown schema key. Why: the model never sees an elicitation, so it cannot get the token or answer for the human; Bash cannot reach the token. Free text under "Other" and "Chat about this" give `null`. Rejected: a pane of our own (more code), URL mode (leaves the terminal), and the forms alone. Install: `/plugin install clank-talk --marketplace bigskysoftware/clank-talk`.
- Approved (built, 2026-11-11): pi shows a choice with all of its text in `ctx.ui.select`. With `any of`, pi has no multi-select, so it shows one yes or no dialog for each choice.
- Approved (built): an answer that is not one of the choices is `null`. A host that fails to ask gives `null`.
- Approved (built): the same choice twice is shown once.
- Approved (built): with no `within`, a question waits at most 2 minutes (`options.askTimeLimit` can change it). This holds for `ask` and the fetch approval. Why: a client that cannot show the dialog, for example on a phone, must not hang the script. No answer in time is `null`, so no. The error for fetch says "nobody answered in time", and the audit says "no answer within 120 s".
- Claude Code supports elicitation (its MCP docs, "Respond to MCP elicitation requests"). Tested by hand on 2026-11-09: the dialog showed the question with the two choices, and the human's pick came back as the result.
- Note: Claude Code has an `Elicitation` hook that can answer with no dialog. It is in `.claude/` settings, which scripts cannot change, because hidden files are refused.
