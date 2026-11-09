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

## Structure

- Approved: commands follow each other with no separator, as in hyperscript. `then` can also separate commands, for example `set x to 1 then print x`.
- Approved: a line end does not stop a value. Use `then` when a separator is needed. HyperTalk was line-based. ClankTalk follows hyperscript here.
- Approved: every block ends with `end`. `end` is always required. Do not copy the flexible `end` rules of hyperscript.
- Approved: a statement that starts with an unknown word is a call to a tool in AGENTS.talk. If AGENTS.talk has no tool with that name, it is an error.

## Commands and expressions

Approved from [examples.md](examples.md). Each rule has an example there.

- `print` is the output to the agent.
- `read` and `fetch` put their value in `it` and `the result`. `read` is also an expression: `set readme to read @/README.md`.
- `ask` asks the human, waits for the answer, and can time out. The answer goes in `the result`.
- `replace a with b in <file>` changes the file itself. `replace a with b in <variable>` changes the variable.
- `write <value> to <file>` and `append <value> to <file>`.
- `as json` parses text to an object, and formats an object to text.
- Approved: `lines <from> to <to> of <file or text>` gives a range of lines, by line number (from 1), with both ends included. `lines` alone is still a plain word.
- Approved: edits by line number. `replace lines 5 to 7 of <file> with <text>`, `put <text> before line 5 of <file>`, `put <text> after line 5 of <file>`, `remove lines 5 to 7 of <file>`.
- Approved: a line edit needs an earlier read of the file, and fails if the file changed since that read.
- Approved: `help` and `help <word>`. See [discoverability.md](discoverability.md).
- Approved: `on error ... end`, with `stop` (the default) and `continue`. See the error rules in [runtime.md](runtime.md).
- Approved: only one `on error` in a script or tool, at its top level. `stop` is only allowed in `on error`, and not in a loop there. `continue` in `on error` (and not in a loop there) means "go on after the failed command".
- `if ... else if ... else ... end`. One `end` closes the whole chain. There is no `otherwise`.
- Loops:
  - `for x in <list> ... end`. Later: also the lines of a file.
  - `repeat <n> times ... end`, `repeat while <condition> ... end`, `repeat until <condition> ... end`.
  - An index on any loop: `index i` or `with index i`.
  - `break` and `continue` in loops. Outside a loop they are errors.
- `increment x by n` and `decrement x by n`. With no `by`, the amount is 1, as in hyperscript.
- Possessive and dot access are the same: `line's number` and `line.number`.
- Approved: `<name> of <value>` is the same as `<value>'s <name>`, as in hyperscript: `lines of the result's output`, `the name of the file`.
- Approved: the value after `of` is a value with access, so `name of the file's parent` is the name of `the file's parent`, and `a of b of c` is `a of (b of c)`. A `$` global is never a property name.
- Approved: text has `lines`, as a file does.
- A file gives `name`, `path`, `text`, `lines`, `size`, `modified`. A line gives `number`, and is its content as text.
- Variables without a prefix are local to the script or feature. `$` variables are global and stay for the session.
- `on error ... end` handles errors. It can go anywhere in a script or feature, and covers all of that script or feature. It can use `stop`, or `continue` to go on with the line after the one that failed. The default is `stop`.
- A tool call gives back `code` and `output`. Arguments can be by position (`run_test 'UserTest'`) or by name (`run_test with name: 'UserTest', mode: 'fast'`), with commas between them.
- Hooks: `before` and `after` for `read`, `write`, `fetch`, `run` and tool calls. Extensions can add more. An `after` hook sees `the result`.

## Expressions

Approved:

- `the` is optional before any expression. It changes nothing. Agents are encouraged to use it where it makes code clearer.
- Approved: after `the`, a word is always a value, even a command word. Thus `the write's path` works in a hook, and `set the write to ...` sets a variable named `write`. Without `the`, a command word at the start of a value is an error. To refer to a command by name, write `the <command>`.
- `it` and `result` are special words. A command sets them. `the result` and `result` are the same.
- Lists `[1, 2]` and objects `{name: 'x'}`, as in JavaScript.
- No function calls in expressions for now.
- Operators: the common ones, as in hyperscript where it makes sense.

Approved (from hyperscript):

- Values: `true`, `false`, `null`.
- Access: `x's y`, `x.y`, `x[0]`.
- Unary: `not x`, `-x`, `no x` (true if `x` is `null`, or an empty string or list).
- Math: `+ - * /` and `mod`.
- Comparison: `is`, `is not`, `is less than`, `is greater than`, `is less than or equal to`, `is greater than or equal to`. Symbols too: `== != < > <= >=`. Both forms stay.
- Text and lists: `contains`, `does not contain`, `starts with`, `ends with`, `is in`, `is not in`, `is empty`, `is not empty`, `exists`, `does not exist`. These also work on files: on a file they use the file's text, so `the file contains 'TODO'` is the same as `the file's text contains 'TODO'`.
- Logic: `and`, `or`.
- Conversion: `as json`, `as pretty json`, `as number`, `as text`. `as json` formats compact JSON, `as pretty json` uses 2-space indents.
- Order, highest first: access, unary, `as`, math, comparison, logic.
- `is not less than` and `is not greater than` do not exist. Use `is greater than or equal to` and `is less than or equal to`.
- Only one comparison in a row. `a < b < c` is an error.
- Only `json`, `number` and `text` can follow `as`. Any other word is an error.
- As in hyperscript, mixing different math operators, or `and` with `or`, without parentheses is an error. `1 + 2 * 3` is an error. Write `1 + (2 * 3)`. This makes the order clear to the reader.

## Tokens

Code: `src/js/tokenizer.js`. The tokenizer makes a flat list of tokens. Each token has a type, a value, a line and a column.

| Type | Example | Note |
|---|---|---|
| word | `set`, `file`, `$last` | Keywords are words. The parser decides what a word means. A word that starts with `$` is a global variable. |
| string | `'var '`, `"let "` | The value has no quotes. Escapes: `\n`, `\t`, `\x` gives `x`. |
| template | `'Hi ${name}'` | A string with `${...}` in it. The value is a list of parts: text, or a token list. |
| number | `2`, `3.5`, `1_000`, `-3` | `_` groups digits and is dropped. |
| path | `./a.js`, `../x`, `@/src/a.js`, `./"my file.txt"` | See paths below. |
| possessive | `'s` | Only when it touches a word and no word character follows. |
| op | `(`, `+`, `.`, `<=` | One character, except `==`, `!=`, `<=`, `>=`. |
| error | | A problem in the source. The value is the message. |

### Syntax status

Each rule is **proposed** until a human approves it. See AGENTS.md.

- Approved: `#` starts a comment, anywhere on a line, to the end of the line.
- Approved: the tokenizer does not make newline tokens. The parser uses `end` and command words to find structure. Tokens keep the line number if the parser needs it later.
- Approved: `'` after a word character is a possessive only before a non-word character. Thus `file's` is a possessive, and `say 'sun'` is a string. `'s` does not work after `)`, `]` or `}`. Use `.` there: `(x as json).a`.
- Approved: both `'` and `"` make strings.
- Approved: a string can span lines. A missing quote takes the rest of the source.
- Approved: `${...}` works in both kinds of string. Any expression can go inside, with quotes too.
- Approved: in a string with line breaks, the indent that all non-blank lines share is removed, so the string can be indented with the script.
- Approved: `\${` gives a plain `${`. This follows the escape rule.
- Approved: raw strings, `"""..."""`. No escapes, no `${}`, and no indent removal: the text is exactly what is between the quotes. Only a line break right after the opening quotes is dropped. A raw string ends at the first `"""`. Use raw strings for code edits.
- Approved: indent details, as in Java text blocks. A line break right after the opening quote is dropped. If the closing quote is on its own line, the text ends with a line break. Blank lines become empty.
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
- Approved: a path also ends at a possessive `'s`, so `./notes.txt's lines` works. Note: `[` and `'` are still part of a path, so `./a.txt['x']` is one path.
- Approved: `./"..."` (and `../"..."`, `@/"..."`) puts the path in double quotes, so it can hold spaces, `)` and `,`.
- Approved: the path ends at the closing quote. Escapes do not work in a quoted path.

### Not yet

- Approved: `$name` in a string is plain text. Only `${...}` is interpolation, because `$` marks a global.
- Approved: URLs. A URL starts with `<word>://` and otherwise follows the path rules.
- Approved for later: `/.../` is a regex. Pending: how to tell a regex from division.
- Wanted: absolute paths (`/etc/hosts`). They also start with `/`, so they wait for the same regex and division decision.
- URLs as their own token type.
- Words with `-` in them.

## Open questions

- Error model: TODO
- Data types: TODO
