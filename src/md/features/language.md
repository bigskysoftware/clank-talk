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
- Approved (built): `line <n> of <file or text>` gives one line, with `number` and `text`. A number past the end is an error: `Line 9 is past the end of a.txt (3 lines)`. `line` alone stays a plain word, such as a loop variable.
- Approved: put a line in a variable first, then use its fields on the next line: `set first to line 1 of ./a.txt` then `set name to first's text`. Not `(line 1 of ./a.txt)'s text`. The help and the docs show the two-line form.
- Approved: edits by line number. `replace lines 5 to 7 of <file> with <text>`, `put <text> before line 5 of <file>`, `put <text> after line 5 of <file>`, `remove lines 5 to 7 of <file>`.
- Approved (built): `replace lines ... with <text>` is always a line edit, and never takes an `in`: `of` names the file. Thus an `in` after it starts a new command, such as an `in ... do` block on the next line.
- Approved: `find <text> in <file, list of files, or text>`. The result is the lines that contain the text, as plain text with letter case. A line from a file has `file`. `print` shows `path:number: text`. `find` reads each file, so read hooks run and line edits can follow. Later, maybe: no letter case.
- Approved (built): patterns. `pattern '<regexp>'` is a value: a JavaScript regexp with the `u` flag. `find pattern ... in <target>` gives the lines that match. `replace pattern ... with <new> in <file or variable>` replaces each match, and the new text can use the back references `$1`, `$<name>`, `$&` and `$$`. `<text> matches pattern ...` is a check. A bad pattern is an error. `pattern` alone stays a plain word: it is a pattern only with a string after it on the same line. Why `pattern` and not `/.../`: `/` starts paths and means division. Use raw strings for backslashes.
- Approved (built): a runaway pattern, such as `(a+)+$`, can run for minutes, and a JS regexp cannot be stopped. So pattern work runs in a worker thread, one for each run, with a 2-second limit for each job. On a timeout, the worker is stopped and the job is an error; the next pattern starts a new worker. Code: `src/js/patterns.js`. Later, maybe: `ignoring case`, and the groups as a value.
- Approved (built): `sorted <list>` and `unique <list>` give a new list. `sorted` puts numbers first, as numbers, then the rest by character code, so the order is the same everywhere. `unique` keeps the first of each value, in order. A line compares by its text, a file by its path, other values by their text. A value that is not a list is an error. With no value after them on the same line, or with a joining word after them (`to`, `is`, ...), they stay plain words. Later, maybe: `sorted ... by <property>`, `reversed`.
- Approved (built): `find` is also a value, as `read` and `fetch` are: `set hits to find 'TODO' in f`, `print find 'x' in f`. Its target takes only a value with access, so `if find 'x' in f is empty` checks the found lines. In an `in ... do` block, it uses the block's target.
- Approved (built): `in <target> replace <old> with <new>` and `in <target> find <text>` name the target first, for one command. They mean the same as the target last. An `in` after them starts a new command, so two `in` commands can follow each other.
- Approved (built): `in <target> do ... end` is a block. Each `replace` and `find` in it with no target uses the block's target, also inside `if` and loops. In the block, `replace` and `find` never take an `in` of their own, so an `in` on the next line starts a new command. `in` is a command word now; `for x in`, `is in`, `in a sandbox` and the target-last forms keep their meaning.
- Approved (built): in an `in ... do` block, line forms with no `of` use the block's target: `lines 5 to 7`, `line 5`, `put ... before line 5`, `replace lines 5 to 7 with ...`, `remove lines 5 to 7`. A bare `read` (nothing after it on its line) reads the block's target. A form with `of` uses its own target. For `line <n>`, the number must be on the same line, so a loop variable named `line` still works.
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
- Approved: a command claims the words that come after its expressions, so `lines a to b of f` and `put x after line n of f` work. Inside `( )`, `of` is a property again. See the follows set in [../infrastructure/parser.md](../infrastructure/parser.md).
- Approved: text has `lines`, as a file does.
- Approved: `first of <x>` and `last of <x>` give the first or last item of a list. For a file or text, the first or last line. An empty list gives null. An object field named `first` or `last` is still its own field.
- A file gives `name`, `path`, `text`, `lines`, `size`, `modified`. A line gives `number`, and is its content as text.
- Variables without a prefix are local to the script or feature. `$` variables are global and stay for the session.
- `on error ... end` handles errors. It can go anywhere in a script or feature, and covers all of that script or feature. It can use `stop`, or `continue` to go on with the line after the one that failed. The default is `stop`.
- A tool call gives back `code` and `output`. Arguments can be by position (`run_test 'UserTest'`) or by name (`run_test with name: 'UserTest', mode: 'fast'`), with commas between them.
- Approved (built): a tool call is also a value, as `read`, `fetch` and `find` are: `set tests to run_tests`. It takes the same arguments and `within`. It runs as the command does, with hooks, the audit and a step, but leaves `the result` as it was. The docs put the value in a variable, then use it on the next line, not `(run_tests)'s code`.
- Hooks: `before` and `after` for `read`, `write`, `fetch`, `run` and tool calls. Extensions can add more. An `after` hook sees `the result`.

## Expressions

Approved:

- `the` is optional before any expression. It changes nothing. Agents are encouraged to use it where it makes code clearer.
- Approved: after `the`, a word is always a value, even a command word. Thus `the write's path` works in a hook, and `set the write to ...` sets a variable named `write`. Without `the`, a command word at the start of a value is an error. To refer to a command by name, write `the <command>`.
- Approved (built): the error for a command word as a name names the fix. `set stop to 5` gives: `'stop' is a command word, so it cannot be a name. Use another name, such as 'my_stop', or write 'the stop'`. A command word in a value gives: `Expected a value, found the command word 'stop'. If it is a name, write 'the stop'`. The grammar does not change.
- `it` and `result` are special words. A command sets them. `the result` and `result` are the same.
- Lists `[1, 2]` and objects `{name: 'x'}`, as in JavaScript.
- No function calls in expressions for now.
- Operators: the common ones, as in hyperscript where it makes sense.

Approved (from hyperscript):

- Values: `true`, `false`, `null`.
- Approved (built): an unknown variable is an error at run time: `Unknown variable 'totl'. Did you mean 'total'? Set it before you use it, for example: set totl to 0`. "Did you mean" names a set variable 1 or 2 letters away. Not errors: an unset `$` global is null (`if $last is null` on the first run); `x exists` and `x does not exist` ask if a variable is set; `increment` and `decrement` start an unset variable at 0; a missing property is null; a missing tool argument is null. Why: a typo, or a name that is not a value (such as a tool name before tool calls were values), gave a silent null.
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
| possessive | `'s` | Only when it touches a word, `)`, `]` or `}`, and no word character follows. |
| op | `(`, `+`, `.`, `<=` | One character, except `==`, `!=`, `<=`, `>=`. |
| error | | A problem in the source. The value is the message. |

### Syntax status

Each rule is **proposed** until a human approves it. See AGENTS.md.

- Approved: `#` starts a comment, anywhere on a line, to the end of the line.
- Approved: the tokenizer does not make newline tokens. The parser uses `end` and command words to find structure. Tokens keep the line number if the parser needs it later.
- Approved: `'` after a word character, `)`, `]` or `}` is a possessive only before a non-word character. Thus `file's`, `[1, 2]'s last` and `(x as json)'s a` are possessives, and `say 'sun'` is a string. This replaces the earlier rule that `'s` does not work after `)`, `]` or `}`.
- Approved: both `'` and `"` make strings.
- Approved: a string can span lines. A missing quote takes the rest of the source.
- Approved: `${...}` works in both kinds of string. Any expression can go inside, with quotes too.
- Approved: in a string with line breaks, the indent that all non-blank lines share is removed, so the string can be indented with the script.
- Approved: `\${` gives a plain `${`. This follows the escape rule.
- Approved: raw strings, `"""..."""`. No escapes, no `${}`, and no indent removal: the text is exactly what is between the quotes. Only a line break right after the opening quotes is dropped. Approved: the help, the MCP rules and the docs say this, and say to leave one empty line after the opening quotes to start with a blank line. A raw string ends at the first `"""`.
- Approved (built): a raw string can open with more than three quotes, and then ends at the same count: `""""...""""` can hold `"""`. In a run of quotes, the last ones close the string, so the text can end with a quote.
- Approved: no warning for a backslash followed by n, r or t in a raw string. In code edits, it is often correct, such as `"\n"` in JS. The changed-lines diff after an edit shows a wrong escape. Use raw strings for code edits.
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
- Approved: a path ends at whitespace, `)`, `,`, or a `]` or `}` with no `[` or `{` before it in the path. Thus `[./a, ./b]` and `{f: ./a}` work, and `./src/[ab].js` is one path.
- Approved: a path also ends at a possessive `'s`, so `./notes.txt's lines` works. Note: `[` and `'` are still part of a path, so `./a.txt['x']` is one path.
- Limit: a `,` ends a path, so a brace glob such as `./src/*.{js,ts}` does not work.
- Approved: `./"..."` (and `../"..."`, `@/"..."`) puts the path in double quotes, so it can hold spaces, `)` and `,`.
- Approved: the path ends at the closing quote. Escapes do not work in a quoted path.

### Not yet

- Approved: `$name` in a string is plain text. Only `${...}` is interpolation, because `$` marks a global.
- Approved (built): URLs. A URL starts with `<word>://` and otherwise follows the path rules. It is a string value: `fetch https://x.com/a?b=1 as json`.
- Approved for later: `/.../` is a regex. Pending: how to tell a regex from division.
- Wanted: absolute paths (`/etc/hosts`). They also start with `/`, so they wait for the same regex and division decision.
- Words with `-` in them.

## Open questions

- Error model: TODO
- Data types: TODO
