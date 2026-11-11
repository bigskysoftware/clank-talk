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

test("a quoted string in a script with CRLF line breaks has LF line breaks", async () => {
  assert.deepEqual(await output("print '\r\n  a\r\n  b\r\n  '"), ["a\nb\n"]);
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

test('raw strings keep quotes, backslashes and ${} as they are', async () => {
  const source = 'print """it\'s "x", a\\nb and ${y}"""';
  assert.deepEqual(await output(source), ['it\'s "x", a\\nb and ${y}']);
});

test('raw strings keep their indent, and drop only the first line break', async () => {
  const source = 'print """\n    a\n      b\n"""';
  assert.deepEqual(await output(source), ['    a\n      b\n']);
});

test('a raw string can be on one line', async () => {
  assert.deepEqual(await output('print """a"""'), ['a']);
});

test('an unterminated raw string is an error', async () => {
  assert.deepEqual(await errors('print """oops'), ['Unterminated raw string', 'Expected a value']);
});

test('a raw string with more quotes ends at the same count, so it can hold three quotes', async () => {
  const q3 = '"'.repeat(3);
  const q4 = '"'.repeat(4);
  assert.deepEqual(await output('print ' + q4 + 'say ' + q3 + 'hi' + q3 + q4), ['say ' + q3 + 'hi' + q3]);
  assert.deepEqual(await output('print ' + q4 + '\n  x\n' + q4), ['  x\n']);
  assert.deepEqual(await errors('print ' + q4 + 'oops' + q3), ['Unterminated raw string: it opens with 4 quotes, so it ends at 4 quotes. For text that starts with a quote, put a line break right after the three opening quotes', 'Expected a value']);
});

// ----- text blocks: lines that start with | -----

test("a text block holds any text, exactly as typed", async () => {
  const script = [
    "set code to",
    '| "a" b',
    "| `tick` and ''' and \"\"\" and ${x} and \\n",
    "print code",
  ].join("\n");
  assert.deepEqual(await output(script), ['"a" b\n`tick` and \'\'\' and """ and ${x} and \\n']);
});

test("one space after the | is dropped, spaces before it are ignored, and | alone is an empty line", async () => {
  const script = [
    "if true",
    "  set code to",
    "  |   indented",
    "  |",
    "  |last",
    "  print code",
    "end",
  ].join("\n");
  assert.deepEqual(await output(script), ["  indented\n\nlast"]);
});

test("an empty | line at the end gives a final line break", async () => {
  assert.deepEqual(await output("set text to\n| one\n|\nprint text's length"), ["4"]);
});

test("a text block can be each side of replace", async () => {
  const tokens = tokenize("replace\n| \"a\" b\nwith\n| \"c\"\nin x");
  assert.deepEqual(tokens.map((t) => [t.type, t.value]), [["word", "replace"], ["string", '"a" b'], ["word", "with"], ["string", '"c"'], ["word", "in"], ["word", "x"]]);
  assert.deepEqual(await output("set x to 'say \"a\" b'\nreplace\n| \"a\" b\nwith\n| \"c\"\nin x\nprint x"), ['say "c"']);
});

test("a | that is not at the start of a line is not a text block", async () => {
  assert.match((await errors("print 1 | 2"))[0], /Unexpected character '\|'/);
});

test("first <n> of and last <n> of give up to n items", async () => {
  assert.deepEqual(await output("print first 2 of [1, 2, 3]\nprint last 2 of [1, 2, 3]"), ["[1,2]", "[2,3]"]);
  assert.deepEqual(await output("print first 5 of [1, 2]\nprint last 0 of [1, 2]"), ["[1,2]", "[]"]);
  // text gives lines; a list of lines prints with their numbers
  assert.deepEqual(await output("set t to 'a\nb\nc'\nprint last 2 of t"), ["2: b\n3: c"]);
  // first of x is still one item, and a variable named first still works
  assert.deepEqual(await output("print first of [1, 2]\nset first to 3\nprint first + 1"), ["1", "4"]);
  assert.match((await errors("print first 1.5 of [1]"))[0], /needs a whole number of items/);
  assert.match((await errors("print first 2 of 7"))[0], /needs a list, a file or text/);
});

test("find in a list of lines keeps their numbers", async () => {
  const script = "set t to 'a TODO\nb\nc TODO\nd TODO'\nprint find 'TODO' in lines 2 to 4 of t\nprint find 'c' in find 'TODO' in t";
  assert.deepEqual(await output(script), ["3: c TODO\n4: d TODO", "3: c TODO"]);
});
