# Language

New parser. Syntax ideas come from hyperscript.

## Keep from hyperscript

- English-like commands: TODO
- Pluggable commands and expressions: the grammar is extensible.
- Async-transparent execution: TODO

## Drop from hyperscript

- DOM features.
- Inline JS blocks. These are an escape from the sandbox.
- TODO

## Tokens

Code: `src/tokenizer.js`. The tokenizer makes a flat list of tokens. Each token has a type, a value, a line and a column.

| Type | Example | Note |
|---|---|---|
| word | `set`, `file` | Keywords are words. The parser decides what a word means. |
| string | `'var '`, `"let "` | The value has no quotes. Escapes: `\n`, `\t`, `\x` gives `x`. |
| number | `2`, `3.5`, `1_000`, `-3` | `_` groups digits and is dropped. |
| path | `./a.js`, `../x`, `@/src/a.js`, `./"my file.txt"` | See paths below. |
| possessive | `'s` | Only when it touches a word and no word character follows. |
| op | `(`, `+`, `.` | One character. |
| error | | A problem in the source. The value is the message. |

### Syntax status

Each rule is **proposed** until a human approves it. See AGENTS.md.

- Approved: `#` starts a comment, anywhere on a line, to the end of the line.
- Approved: the tokenizer does not make newline tokens. The parser uses `end` and command words to find structure. Tokens keep the line number if the parser needs it later.
- Approved: `'` after a word character is a possessive only before a non-word character. Thus `file's` is a possessive, and `say 'sun'` is a string.
- Approved: both `'` and `"` make strings.
- Approved: string escapes `\n`, `\t`, and `\x` for any other `x`.
- Approved: numbers have no commas. `_` groups digits: `1_000`.
- Approved: negative numbers.
- Approved: `-` is part of a number only if a digit follows and the `-` comes after the start, whitespace, or one of `( [ { , = :`. Thus `set x to -3`, `[-1]` and `x=-1` have negative numbers, and `x - 3` and `x-3` are subtraction. Note: `x -3` is also a negative number.
- Problems do not stop the tokenizer. Each problem becomes an error token with the line and column where it starts, and tokenizing goes on. The compiler reports all errors together. This is not syntax.

### Paths

- Approved: `./` and `../` are relative to the current directory.
- Approved: `@/` is relative to the project root.
- Approved: `../` is legal syntax. The sandbox can refuse a path that goes outside the project root.
- Approved: a path ends at whitespace, `)` or `,`.
- Approved: `./"..."` (and `../"..."`, `@/"..."`) puts the path in double quotes, so it can hold spaces, `)` and `,`.
- Approved: the path ends at the closing quote. Escapes do not work in a quoted path.

### Not yet

- Template strings.
- Approved for later: `/.../` is a regex. Pending: how to tell a regex from division.
- URLs as their own token type.
- Words with `-` in them.

## Open questions

- Error model: TODO
- Data types: TODO
