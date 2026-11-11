# Language

New parser. Syntax ideas come from hyperscript.

## Keep from hyperscript

- English-like commands.
- Pluggable commands and expressions: the grammar is extensible.
- Async-transparent execution: `fetch`, `wait`, `ask` and tool calls read as plain steps, with no await.

## Drop from hyperscript

- DOM features.
- Inline JS blocks. These are an escape from the sandbox.

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
- `as json` parses text to an object, and formats an object to text. On a file or a line, it parses the text.
- Approved: `lines <from> to <to> of <file or text>` gives a range of lines, by line number (from 1), with both ends included. `lines` alone is still a plain word.
- Approved (built): `line <n> of <file or text>` gives one line, with `number` and `text`. A number past the end is an error: `Line 9 is past the end of a.txt (3 lines)`. `line` alone stays a plain word, such as a loop variable.
- Approved: put a line in a variable first, then use its fields on the next line: `set first to line 1 of ./a.txt` then `set name to first's text`. Not `(line 1 of ./a.txt)'s text`. The help and the docs show the two-line form.
- Approved (built): `delete <file>` deletes one file. It has the checks of a write, and it takes no folder, no glob and no list. A missing file is an error. undo puts the file back. A link is deleted itself, not the file it points to. Hooks: `before delete` and `after delete`; a delete is also a `change`. `git commit` of the path commits the removal. The name is `delete`, because `remove lines` is a line edit.
- Approved (built): `move <file> to <file>` moves or renames one file. It has the checks of a write for both paths, and it never replaces a file. It makes the folder of the new path. undo takes it back: the change list has the old path (text to nothing) and the new path (nothing to text). Hooks: `before move` and `after move`, with `the move's path` and `the move's to`.
- Approved: edits by line number. `replace lines 5 to 7 of <file> with <text>`, `put <text> before line 5 of <file>`, `put <text> after line 5 of <file>`, `remove lines 5 to 7 of <file>`.
- Approved (built): `replace lines ... with <text>` is always a line edit, and never takes an `in`: `of` names the file. Thus an `in` after it starts a new command, such as an `in ... do` block on the next line.
- Approved (built): `replace <old> with <new> in <files>` takes a file, a list of files, or a glob, as `find` does. Every file is checked first, so one file that cannot change (a hidden file, a `.talk` file) stops it before any write. Each file changes only if it has a match. The result is all the replacements; one warning if there is no match in any file. One undo takes back all the files. A glob with no files is an error.
- Approved (built): `first <n> of <x>` and `last <n> of <x>` give a list of up to n items; a file or text gives lines. A shorter list gives all of it. `first of x` stays one item. The count must be a whole number, 0 or more. `first` is this form only when a value and `of` follow it, so a variable named `first` still works.
- Approved: `find <text> in <file, list of files, or text>`. The result is the lines that contain the text, as plain text with letter case. A line from a file has `file`. `print` shows `path:number: text`. `find` reads each file, so read hooks run and line edits can follow. Later, maybe: no letter case.
- Approved (built): `find` also takes a list of lines, such as `lines 5 to 9 of f`, `first 10 of f`, or an earlier `find`. The lines keep their numbers and files, so `find 'c' in find 'TODO' in ./src/*.js` narrows a search.
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
- Approved: after `the`, a word is always a value, even a command word. Thus `the write's path` works in a hook, and `set the write to ...` sets a variable named `write`. Without `the`, a command word at the start of a value is an error. To refer to a command by name, write `the <command>`. Approved (built): a tool name after `the` is a value too, so a hook for a tool reads `the deploy's args`.
- Approved (built): the error for a command word as a name names the fix. `set stop to 5` gives: `'stop' is a command word, so it cannot be a name. Use another name, such as 'my_stop', or write 'the stop'`. A command word in a value gives: `Expected a value, found the command word 'stop'. If it is a name, write 'the stop'`. The grammar does not change.
- Approved (built): `end`, `then` and `else` are block words, and cannot be names, also after `the`. `set end to 1` gives one error: `'end' is a block word, so it cannot be a name. Use another name, such as 'last'`.
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
- Approved (built): a hyphen is part of a word when a letter comes right after it: `build-dir`, `content-type`, `x2-beta`. Thus names, properties and tool names can have hyphens. `n-1` and `a - b` stay subtraction. An unknown name with a hyphen gets a hint in its error: `For subtraction, put spaces around the minus: total - tax`. Why: JSON keys and headers often have hyphens, and kebab names read well.
- Approved: the tokenizer does not make newline tokens. The parser uses `end` and command words to find structure. Tokens keep the line number if the parser needs it later.
- Approved: `'` after a word character, `)`, `]` or `}` is a possessive only before a non-word character. Thus `file's`, `[1, 2]'s last` and `(x as json)'s a` are possessives, and `say 'sun'` is a string. This replaces the earlier rule that `'s` does not work after `)`, `]` or `}`.
- Approved: both `'` and `"` make strings.
- Approved: a string can span lines. A missing quote takes the rest of the source.
- Approved (built): in a script with CRLF line breaks, a quoted string that spans lines has LF line breaks, as `|` blocks and raw strings do.
- Approved: `${...}` works in both kinds of string. Any expression can go inside, with quotes too.
- Approved: in a string with line breaks, the indent that all non-blank lines share is removed, so the string can be indented with the script.
- Approved: `\${` gives a plain `${`. This follows the escape rule.
- Approved: raw strings, `"""..."""`. No escapes, no `${}`, and no indent removal: the text is exactly what is between the quotes. Only a line break right after the opening quotes is dropped. Approved: the help, the MCP rules and the docs say this, and say to leave one empty line after the opening quotes to start with a blank line. A raw string ends at the first `"""`.
- Approved (built): a raw string can open with more than three quotes, and then ends at the same count: `""""...""""` can hold `"""`. In a run of quotes, the last ones close the string, so the text can end with a quote.
- Approved: no warning for a backslash followed by n, r or t in a raw string. In code edits, it is often correct, such as `"\n"` in JS. The changed-lines diff after an edit shows a wrong escape. Use raw strings for code edits.
- Approved (built): text blocks: lines that start with `|`. A block can stand wherever a value goes, when the value starts on the next line. Spaces before the `|` are ignored, and one space after it is dropped; the rest of the line is the text, exactly as typed: no escapes, no `${}`, and quotes, backticks and three double quotes are plain text. A line with only `|` is an empty line. The lines join with line breaks; the text has no final line break, and an empty `|` line at the end adds one. The block ends at the first line that does not start with `|`. Why: raw strings fail when the text starts with a quote or holds three double quotes, and backticks clash with Markdown and JavaScript. `|` has no other use in ClankTalk; `>` is "greater than". Recommended for code and for any text with quotes.

```talk
replace
| "a" b
with
| "c"
in ./src/app.js
```

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
- Approved (built): a `/` right after the closing quote goes on with the path: `./"my dir"/a.txt` is `my dir/a.txt`. Before, the `/` was a division.

### Not yet

- Approved: `$name` in a string is plain text. Only `${...}` is interpolation, because `$` marks a global.
- Approved (built): URLs. A URL starts with `<word>://` and otherwise follows the path rules. It is a string value: `fetch https://x.com/a?b=1 as json`.
- Approved for later: `/.../` is a regex. Pending: how to tell a regex from division.
- Wanted: absolute paths (`/etc/hosts`). They also start with `/`, so they wait for the same regex and division decision.
- Done: words with `-` in them. A hyphen joins a word when a letter follows it.

## Errors for agents (audit review, 2026-11-10)

- Approved (built): a pattern that is not valid adds a hint for the common causes: an inline flag such as `(?i)`; an escape that the `u` flag rejects, such as `\-` outside `[...]`; and a group or quantifier that broke because a quoted string took a backslash.
- Approved (built): an error that ends in `found null` adds: "the value has nothing in it. If it came from an earlier find or fetch, that command found nothing."
- Approved (built): the tool description asks agents to start each script with a `#` line that says what it is for. The audit shows it in the header.
- Rejected: a rule of one task for each script. A long script for one job is fine, and the `#` line already says what it is for.

- Approved (built): `pattern /regex/flags`. After the word `pattern`, a `/` starts a raw regex: no string escapes and no templates, a `/` inside is `\/`, and a `/` inside `[...]` does not end it. Flags: `i`, `m` and `s`, once each; `u` is always on, and `g` is not needed. An unclosed `/` on the line is an error. `pattern '...'` still works. Why: in a quoted string, `\(` reaches the regex as `(`, and that caused most failed patterns in the audit. Rejected: `pattern( ... )`, because a regex holds parentheses, and it has no place for flags.

## Open questions

- Error model: TODO
- Data types: TODO
