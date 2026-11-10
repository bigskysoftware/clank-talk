# ClankTalk for VS Code

Syntax highlighting for `.talk` files and `AGENTS.talk`: keywords, strings with `${...}`, raw strings, paths, URLs, numbers, comments and `'s`. `#` toggles comments, and blocks indent and outdent on `end`.

## Install

Copy or link this folder into your VS Code extensions folder, and restart VS Code:

```bash
ln -s "$PWD/editors/vscode" ~/.vscode/extensions/clanktalk
```

## Other editors

The grammar is a TextMate grammar, `syntaxes/clanktalk.tmLanguage.json`. Editors that read TextMate grammars can use this folder too. For example, in IntelliJ: Settings, Editor, TextMate Bundles, then add this folder.

## Limits

The grammar follows `src/js/tokenizer.js`, but a regex is not the tokenizer: a path with a glob in `[ ]` can end early, and a string that spans lines is not always caught. The site highlighter (`docs/highlight.js`) uses the real tokenizer.
