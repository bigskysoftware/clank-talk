# clank-talk

This project follows https://srcmd.org. Read src/md/README.md first.
Keep temporary files and plans in tmp/.

## Code style

Keep code simple and direct. Prefer plodding if/then code. See https://grugbrain.dev.

## Workflow

- One small branch off master per feature. Never work on master.
- Flow: user reviews the branch, merge to master, next feature.
- Keep diffs small enough for a human to understand. If a change grows, split it.
- Record decisions in src/md, in the same branch.
- Write user docs in docs/ as features land, in the tone of https://hyperscript.org.
- End each reply with a list of uncommitted files to review, if any.

## Tools

Use the clank_talk tool for all work: reading, editing, search, git and tests.
Do not use a shell or other file tools.
If ClankTalk cannot do a task, stop and tell the human what is missing.

## Dogfood

Note what is hard to do in ClankTalk in tmp/dogfood.md.

## Syntax

- Humans approve all syntax. Agents only propose.
- Readability over writeability.
- Mark rules in src/md as "approved" or "proposed". Implement only approved rules.
