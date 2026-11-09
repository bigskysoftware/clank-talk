# Parser

Code: `src/js/parser.js`. `parse(source, { tools })` gives `{ script, errors }`.

## Decisions (not syntax)

- The parser does not throw. Tokenizer errors and parse errors go in one `errors` list, in source order for each stage. Each error has `message`, `line` and `column`.
- After an error, the parser skips tokens up to the next command word, `then` or `end`, and goes on. One mistake in a command gives one error.
- Expressions use a simple recursive descent parser: one function for each level, and each level calls the level below it.
- Commands are in a table, `COMMANDS`, from a command word to a parse function. Plugins will add to this table later.
- The parser gets the AGENTS.talk tool names in `options.tools`. A statement that starts with one of these names is a `toolCall`. Any other unknown word is an error.
- Every node has `type`, `line` and `column`.

## Tree shape

```
{ type: "script", commands: [...] }
{ type: "print", value }
{ type: "if", condition, body: [...] }
{ type: "lines", from, to, target }      lines 1 to 5 of <file or text>
{ type: "replaceLines", range, text }    range is a "lines" node
{ type: "removeLines", range }
{ type: "put", text, where, number, file }   where: "before" or "after"
{ type: "read", file }                  a command, and also an expression
{ type: "write" | "append", value, file }
{ type: "replace", old, replacement, target }
{ type: "set", target, value }          target: variable, property or index
{ type: "for", name, list, index, body: [...] }       index is a name or null
{ type: "repeat", kind, value, index, body: [...] }   kind: "times", "while" or "until"
{ type: "onError", body: [...] }        top level of a script or tool only
{ type: "stop" }
{ type: "help", word }                  word is null, or the words after help on the same line
{ type: "break" }
{ type: "continue" }
{ type: "increment" | "decrement", target, amount }   amount is 1 when there is no "by"
{ type: "toolCall", name, args: [...], named: [{ name, value }], within }   within is a duration or null
{ type: "run", program, args, within }   args is null for "run 'a b'" (split on spaces)
{ type: "duration", value, ms }          ms: the length of one unit
{ type: "allowEnv", names: [...] }
{ type: "import", path }
{ type: "hook", when, name, body: [...] }   when: "before" or "after"; AGENTS.talk only
{ type: "reject", message }             only in a "before" hook                AGENTS.talk and imported files only       AGENTS.talk only
{ type: "tool", name, params: [...], body: [...] }     AGENTS.talk only
{ type: "definitions", definitions: [...] }            the top of AGENTS.talk
{ type: "string" | "number" | "path" | "boolean", value }
{ type: "null" }
{ type: "template", parts: [...] }      parts are text or expression nodes
{ type: "result" }                      it, result
{ type: "variable", name }
{ type: "property", object, name }      x's name, x.name
{ type: "index", object, index }        x[0]
{ type: "unary", operator, value }      not x, no x, -x
{ type: "binary", operator, left, right }
{ type: "check", operator, value }      x exists, x is empty
{ type: "conversion", value, to }       x as json
{ type: "list", items: [...] }
{ type: "object", fields: [{ name, value }] }
```

`the` and parentheses leave no node.

Operator names are always the word form. `<` gives `is less than`, `==` gives `is`. This keeps the tree, and later the audit log, easy to read.

## Not yet

- Tool call arguments.
- `else`.

## Line ends

Approved: a line end does not stop a value, as in hyperscript. A value goes on until the grammar stops it. Use `then` to separate commands when needed. Thus:

```talk
print
total
```

prints `total`.

## Follows set

Approved. From hyperscript: `src/core/tokenizer.js` (`pushFollows`, `popFollows`, `clearFollows`, `restoreFollows`) and `ParenthesizedExpression` in `src/parsetree/expressions/expressions.js`.

The problem: `lines n to n of ./a.txt` fails with "Expected 'of'". The parser reads `n of ./a.txt` as the property `n` of `./a.txt`, by the approved `<name> of <value>` rule. Thus the range has no `of`. `put x after line n of f` has the same trap.

The rule:

- Approved: a command can claim the words that come after an expression, for example `of` in `lines a to b of f`. While a word is claimed, the expression does not take it. Thus `b of f` is not a property there, and `b` is the end of the expression.
- Approved: the claimed words are a stack (the follows set). A command pushes words before it parses an expression, and pops them after.
- Approved: `(` clears the follows set. After the closing `)`, the set is back as it was. Thus `lines 1 to (count of f) of f` works: inside the parentheses, `of` is a property again.
- Approved: only `( )` clears the set, as in hyperscript. `[ ]`, `{ }` and `${ }` do not.
- Approved: after a parse error, the parser clears the set, as hyperscript does.

Where commands claim words:

| Command | Expression | Claimed words |
|---|---|---|
| `lines <a> to <b> of <x>` | `<a>` | `to` |
| `lines <a> to <b> of <x>` | `<b>` | `of` |
| `put <text> before\|after line <n> of <file>` | `<text>` | `before`, `after` |
| `put ... line <n> of <file>` | `<n>` | `of` |
| `replace <a> with <b> in <x>` | `<a>`, `<b>` | `with`, `in` |
| `find <text> in <x>` | `<text>` | `in` |
| `write`, `append <value> to <file>` | `<value>` | `to` |

Only `of` is a real problem today, because the other words are not operators. Claims for them keep a later operator from breaking a command.

Code (`src/js/parser.js`):

```js
// parse an expression that must stop before the claimed words
function parseBefore(words, parse) {
  const saved = follows;
  follows = follows.concat(words);
  try {
    return parse();
  } finally {
    follows = saved;
  }
}
```

`isWord(value)` gives false for a claimed word, as `matchToken` does in hyperscript. A command checks its own word after the pop, so it still sees it.
