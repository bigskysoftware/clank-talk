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
{ type: "toolCall", name }
{ type: "string" | "number" | "path" | "boolean", value }
{ type: "null" }
{ type: "result" }                      it, result
{ type: "variable", name }
{ type: "property", object, name }      x's name, x.name
{ type: "index", object, index }        x[0]
{ type: "list", items: [...] }
{ type: "object", fields: [{ name, value }] }
```

`the` and parentheses leave no node.

## Not yet

- Operators (next branch).
- Tool call arguments.
- `else`.

## Line ends

Approved: a line end does not stop a value, as in hyperscript. A value goes on until the grammar stops it. Use `then` to separate commands when needed. Thus:

```talk
print
total
```

prints `total`.
