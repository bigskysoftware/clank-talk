import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/js/clank-talk.js";
import { tokenize } from "../src/js/tokenizer.js";

async function output(source) {
  const result = await run(source);
  assert.deepEqual(result.errors, []);
  return result.output;
}

async function errors(source) {
  const result = await run(source);
  return result.errors.map((e) => e.message);
}

test("strings can span lines", async () => {
  assert.deepEqual(await output("print 'a\nb'"), ["a\nb"]);
});

test("a missing quote takes the rest of the source", () => {
  const tokens = tokenize("print 'oops\nprint 1");
  assert.deepEqual(tokens.map((t) => t.type), ["word", "error"]);
});

test("common indent is removed", async () => {
  const source = [
    "set code to '",
    "    function f() {",
    "      return 1",
    "    }",
    "    '",
    "print code",
  ].join("\n");
  assert.deepEqual(await output(source), ["function f() {\n  return 1\n}\n"]);
});

test("closing quote on the last text line gives no final line break", async () => {
  assert.deepEqual(await output("print '\n  a\n  b'"), ["a\nb"]);
});

test("blank lines inside are kept, but made empty", async () => {
  assert.deepEqual(await output("print '\n  a\n   \n  b'"), ["a\n\nb"]);
});

test("one-line strings keep their spaces", async () => {
  assert.deepEqual(await output("print '  a  '"), ["  a  "]);
});

test("code with every quote goes in a string with escapes only for its own quote", async () => {
  assert.deepEqual(await output("print \"it's `x` and \\\"y\\\"\""), ["it's `x` and \"y\""]);
});

test("${} in single and double quotes", async () => {
  assert.deepEqual(await output("set name to 'Bob'\nprint 'Hi ${name}!'\nprint \"Hi ${name}!\""), ["Hi Bob!", "Hi Bob!"]);
});

test("${} holds any expression", async () => {
  assert.deepEqual(await output("set x to {n: 2}\nprint 'n+1 is ${x's n + 1}'"), ["n+1 is 3"]);
});

test("quotes inside ${} do not end the string", async () => {
  assert.deepEqual(await output("print 'a ${'b' + 'c'} d'"), ["a bc d"]);
});

test("${} in a multi-line string", async () => {
  assert.deepEqual(await output("set n to 3\nprint '\n  count:\n    ${n}'"), ["count:\n  3"]);
});

test("\\${ is a plain ${", async () => {
  assert.deepEqual(await output("print 'cost: \\${x}'"), ["cost: ${x}"]);
});

test("$name without braces is plain text", async () => {
  assert.deepEqual(await output("set $x to 1\nprint '$x'"), ["$x"]);
});

test("empty ${} is an error", async () => {
  assert.deepEqual(await errors("print 'a ${} b'"), ["Empty ${} in a string"]);
});

test("a bad expression in ${} is an error", async () => {
  assert.deepEqual(await errors("print 'a ${1 2} b'"), ["Unexpected '2' in ${}"]);
});

test("an unclosed ${ is an unterminated string", async () => {
  assert.deepEqual(await errors("print 'a ${x'"), ["Unterminated string", "Expected a value"]);
});
