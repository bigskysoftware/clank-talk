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

## Value rules (approved)

- A loop index starts at 0, as in hyperscript.
- `for x in null` makes no passes. A value that is not a list is an error.
- The loop variable and the index are ordinary variables. They stay set after the loop.

- `increment` and `decrement` on a variable that is not set start at 0.

These are semantics, not syntax. A human approved them.

- An unknown variable is `null`, as in hyperscript.
- A missing property is `null`. A property of `null` is `null`.
- `is` is strict: `1 is '1'` is false.
- `+` joins text if either side is text. Otherwise it adds numbers.
- Math on a value that is not a number is an error. Text that holds a number, such as `'2'`, counts as a number.
- Division by zero is an error.
- False values: `false`, `null`, `0`, `''` and `[]`. All other values are true. `[]` is false, unlike in JavaScript.
- `no x` and `x is empty` are true for `null`, `''`, `[]` and `{}`.
- `contains` works on text and lists. On `null` it is false. On other values it is an error. Later: `contains` and the other text operators also work on files, through the file's text (see [language.md](language.md)).
- `as json` on text parses it. On any other value it formats it with 2-space indents.
- `print` shows text as it is, `null` as `null`, and lists and objects as compact JSON.
