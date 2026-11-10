# Runtime

Code: `src/js/runtime.js`.

## Execution

`start(source, options)` gives an execution object at once. The host uses it to watch, cancel and wait:

```js
const execution = start(source, { tools, maxSteps, globals, onStep, signal });
execution.status      // "running", "done", "failed" or "cancelled"
execution.steps       // steps so far
execution.output      // output lines so far
execution.cancel()    // stop at the next step
execution.signal      // AbortSignal, also given to tools
await execution.done  // { status, output, errors, steps }
```

`run(source, options)` is a short form of `start(source, options).done`.

- The script starts one tick after `start()` returns, so the host has the object before the first `onStep` call.
- Cancel takes effect at the next step. A tool gets `{ signal }`, so slow work can stop at once.
- A tool that throws gives a script error: "Tool 'x' failed: ...".

## Decisions (not syntax)

- The runtime stays in one file, `src/js/runtime.js`. Do not split it.
- Parse errors stop the script before it runs.
- A runtime error stops the script. `on error` comes later.
- Everything is async, so later commands (`read`, `fetch`, `ask`) can wait without a change to how scripts are written.
- Each command is one step, and each pass of a loop is one step. When the step count goes over `maxSteps` (default 10,000), the script stops. Thus `repeat while true end` stops too.
- `break` and `continue` pass up from `runCommand` as a return value, until a loop takes them.
- `print` adds a line to `output`.
- Local variables last for one run. `$` globals live in `options.globals`. A host keeps them for a session when it passes the same object to each run.
- An error message shows at most 80 characters of a value, then the full length: `'aaa...'... (100 characters)`. Thus a wrong value, such as the text of a whole file, does not flood the agent.
- Approved: warnings are problems that do not stop the script, in `execution.warnings`: `{ message, line, column, file }`. A `replace` with no match gives a warning, because it is often a mistake, such as a wrong line break or indent. It is not an error, so `if the result is empty` still works.

## Files

Approved. Code: the "files" section of `src/js/runtime.js`.

- A path literal gives a file object. Nothing is read until a property is used.
- A path with `*` or `?` is a glob. It gives a list of files (not folders), sorted by path.
- Approved (built): a bare path keeps a `,` inside braces, so `@/src/**/*.{js,md}` is one glob. A `,` outside braces still ends the path: `[@/a.md, @/b.md]`. A path with an open `{` or `[` is an error: `Unclosed { or [ in a path`.
- Approved (built): where a command takes a file or a list of files (`find`, `git commit`, `git diff`, `for`), a glob in the list adds its files: `[@/package.json, @/src/js/*.js]`. A file named twice is there once. A list of other values stays as it is.
- Approved (built): a glob skips `.git`, and the files and folders that git ignores (`.gitignore`, `.git/info/exclude`, the global excludes file). The hardened git lists them. If the fixed part of the pattern names an ignored folder, the glob looks in it: `./**/*.js` skips an ignored `dist/`, and `./dist/**/*.js` still works. Outside a git repo, or if the repo config can run programs, a glob skips only `.git`. No folder names are special cases. This replaces the `node_modules` rule.
- The host gives `root`. `@/` is relative to `root`. `./` and `../` are relative to `cwd` (default: `root`).
- A file has `name`, `path` (relative to the root, with `/`), `text`, `lines`, `size` (bytes) and `modified` (ISO date).
- A line has `number` (from 1) and `text`. As text, a line is its content. A final line break does not make an extra line. A `\r` at the end of a line is removed.
- `contains`, `does not contain`, `starts with`, `ends with`, `is in` and `is empty` use the text of a file or a line.
- Approved (built): `+` and `${}` join a file as its path, such as `src/a.js`, and a line as its text. To join the text of a file, write it: `'x' + file's text`. Why: a path is what a reader expects, and the text of a file that the agent wrote must not slip into a `run` argument, a URL or a message. Before, they gave the text of the file.
- `print` shows a file as its path. A list of files prints as a list of paths.
- `read <file>` puts the text in the result. `read <file>` is also an expression. Its argument is only a value with access, so `read ./a.txt + '!'` reads `./a.txt` and then adds `'!'`.
- A missing file is an error for `read`. `exists` is false for it.
- All files are UTF-8.
- Approved (built): a BOM at the start of a file does not show in `read`, `text`, `lines` or line edits. A change to a file that had a BOM keeps it.
- Approved (built): a script cannot change a file that is not UTF-8 text: `write`, `append`, `replace` and line edits are refused. Reads still work. Why: a change would turn each bad byte into U+FFFD, and undo could not put the bytes back.
- Built (a fault found in the testing pass): a line edit keeps the CRLF line breaks of a file. New lines get `\r\n` too, and the old lines in the result have no `\r`.
- Approved, stale-write check: the runtime remembers the text of each file when a script reads or writes it. If `write` or `replace` finds that the file on disk changed since then, it fails with "File changed since it was read". The agent reads the file again, and makes its edit again. Nothing is merged.
- Approved: `append` is not checked, because it keeps what is in the file. A `write` to a file that the script did not read is not checked.
- Approved: `options.seen` (a Map) holds what was read. A host passes the same Map to each run, so the check works across runs.
- Later, if this fails too often: a three-way merge at `write`.
- Approved: a range past the end of the file stops at the last line. A range that starts after its end is empty. Neither is an error.
- Approved (built): a range needs whole numbers, and it starts at 1 or more: `lines 0 to 1` is an error, `Line numbers start at 1`. Before, 0 and negative starts were clamped to 1. `repeat` needs a whole number of times too. 0 or fewer times is no pass.
- Approved: `print` shows a list of lines with their numbers (`551: text`), one line each. As text (`as text`, `+`, `write`), a list of lines is its text, one line each, with no numbers.
- Approved: `lines ... of` also works on text, so tool output can be split into lines.
- Approved: line edits split the new text into lines, so a final line break in it does not add an empty line. The file keeps its own final line break.
- Approved: empty text is one empty line, so `put '' after line 5 of f` adds an empty line. Use `remove lines` to take lines away.
- Approved: a line edit outside the file (or with a number that is not whole) is an error, unlike a read range.
- Approved (built): in an empty file, `put ... before line 1` and `put ... after line 0` add the first line.
- Approved: the result of a line edit is the old lines, so `print the result` shows what changed. For `put`, the result is empty.
- Approved, on error: the handler gets a local variable `error` with `message`, `line`, `column` and (for errors in AGENTS.talk) `file`.
- Approved: `continue` goes on with the command after the failed one, in the same block. In a loop, that is the next command in the loop body.
- Approved: with `stop`, the script ends with status `failed` and the original error. With `continue`, the error is gone and the status can be `done`.
- Approved: a tool has its own `on error`. If a tool stops with an error, the caller's `on error` can still handle it.
- Approved: these are never handled: an error inside `on error` itself, cancel, and the step budget.
- Line numbers shift after an edit. A second edit in the same script sees the new numbers.
- `write` and `append` make a missing file, and missing parent folders.
- What goes in: text as it is; a file or line gives its text; lists and objects as compact JSON.
- Approved (built): a `replace` that gives the same text writes nothing, so it adds no undo step.
- `replace` changes every match. The result is a list of replacements, `{ line, column, old, new }`, with the place of each match in the old text. With no match, nothing changes and the result is empty. `replace` of empty text is an error.
- A glob with several files is not a write target. Use a `for` loop.
- Each write records `{ path, before, after }` in `execution.changes`, and the run result has `changes`. `before` is `null` for a new file. This is the start of undo.

## Value rules (approved)

- A loop index starts at 0, as in hyperscript.
- `for x in null` makes no passes. A value that is not a list is an error.
- The loop variable and the index are ordinary variables. They stay set after the loop.

- `increment` and `decrement` on a variable that is not set start at 0.

These are semantics, not syntax. A human approved them.

- An unknown variable is `null`, as in hyperscript.
- A missing property is `null`. A property of `null` is `null`.
- `is` is strict: `1 is '1'` is false.
- Approved (built): `is`, `is not`, `contains` on a list, and `is in` a list compare a file by its path, and a line by its text. Thus `./a.js is @/a.js` is true, `(./src/*.js) contains ./src/a.js` is true, and `(line 1 of f) is 'x'` compares the text. Before, they compared objects, so a hook check such as `if file is @/package.json` never matched. Approved (built): lists and objects are the same if their content is the same, at any depth: `[1, 2] is [1, 2]` is true. Before, they were the same only if they were one value.
- Approved (built): `null` is an error where it would leave as the text `null`: a `run` or `start` argument, a fetch header, a commit message, a branch name, an `ask` question or choice, the text of `write`, `append`, `put` and `replace lines`, and the old or new text of `replace`. To make an empty file, write `''`. `+`, `${}` and `print` still show `null`.
- `+` joins text if either side is text. Otherwise it adds numbers.
- Math on a value that is not a number is an error. Text that holds a number, such as `'2'`, counts as a number.
- Approved (built): `<`, `>`, `<=` and `>=` compare numbers only, by the same rule. Text that is not a number gives: `A comparison such as < needs numbers, and 'a' is not a number`.
- Division by zero is an error.
- Approved: `mod` is the remainder, as in JavaScript, Java and C. The sign follows the left side: `-7 mod 3` is -1.
- False values: `false`, `null`, `0`, `''`, `[]` and `{}`. All other values are true. `[]` and `{}` are false, unlike in JavaScript. Approved (built): `{}` was true before, though `{}` is empty.
- `no x` and `x is empty` are true for `null`, `''`, `[]` and `{}`.
- `contains` works on text and lists. On `null` it is false. On other values it is an error. Later: `contains` and the other text operators also work on files, through the file's text (see [language.md](language.md)).
- Approved (built): `contains`, `starts with` and `ends with` with `null` on either side of a text check give false. Before, `null` was the text `null`, so `'xnullx' contains null` was true. A list check does not change: `[1, null] contains null` is true.
- Approved (built): `set x[i]` on a list needs a whole number `i` from 0 to the length. At the length, it adds an item. Thus a list has no gaps, and `set x[100000000]` cannot make a list too large to print. `set x's length` is refused.
- Built (a fault found in the testing pass): a value cannot hold itself (`set x.a to x`), because it would have no end as text or JSON.
- Built (a fault found in the testing pass): math that gives Infinity or NaN is an error ("The result is too large to be a number"). `as number` refuses `'Infinity'` and `'1e400'`. A number literal too large for JavaScript is a parse error. Later: `contains` and the other text operators also work on files, through the file's text (see [language.md](language.md)).
- `as json` on text parses it. On any other value it formats it as compact JSON. `as pretty json` uses 2-space indents.
- Approved (built): `as json` on a file or a line parses its text, so `./data.json as json` gives the data. Before, it gave the path as a JSON string.
- `print` shows text as it is, `null` as `null`, and lists and objects as compact JSON.
