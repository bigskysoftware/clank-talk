import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/js/clank-talk.js";

// run a script and give back its output, failing the test on any error
async function output(source, options) {
  const result = await run(source, options);
  assert.deepEqual(result.errors, []);
  return result.output;
}

async function errors(source, options) {
  const result = await run(source, options);
  return result.errors.map((e) => e.message + " @" + e.line + ":" + e.column);
}

test("print values", async () => {
  assert.deepEqual(await output("print 'hi' print 2 print true print null"), ["hi", "2", "true", "null"]);
});

test("print lists and objects as JSON", async () => {
  assert.deepEqual(await output("print [1, 'a'] print {name: 'x'}"), ['[1,"a"]', '{"name":"x"}']);
});

test("math", async () => {
  assert.deepEqual(await output("print 1 + 2 print 7 mod 3 print -(2 * 3)"), ["3", "1", "-6"]);
});

test("+ joins text", async () => {
  assert.deepEqual(await output("print 'a' + 1"), ["a1"]);
});

test("division by zero is an error", async () => {
  assert.deepEqual(await errors("print 1 / 0"), ["Division by zero @1:9"]);
});

test("math on text that is not a number is an error", async () => {
  assert.deepEqual(await errors("print 'a' * 2"), ["Expected a number, found 'a' @1:11"]);
});

test("comparison", async () => {
  assert.deepEqual(await output("print 1 is 1 print 1 is not 2 print 1 < 2 print 2 >= 3"), ["true", "true", "true", "false"]);
});

test("text and list operators", async () => {
  assert.deepEqual(
    await output("print 'abc' contains 'b' print [1, 2] contains 3 print 2 is in [1, 2] print 'a.env' ends with '.env'"),
    ["true", "false", "true", "true"],
  );
});

test("checks", async () => {
  assert.deepEqual(
    await output("print x exists print x does not exist print '' is empty print [1] is not empty print no []"),
    ["false", "true", "true", "true", "true"],
  );
});

test("logic", async () => {
  assert.deepEqual(await output("print true and false print true or false print not true"), ["false", "true", "false"]);
});

test("as json goes both ways", async () => {
  assert.deepEqual(await output("print ('{\"a\": 1}' as json).a"), ["1"]);
  assert.deepEqual(await output("print [1] as json"), ["[1]"]);
  assert.deepEqual(await output("print [1] as pretty json"), ["[\n  1\n]"]);
});

test("bad JSON is an error", async () => {
  const [message] = await errors("print 'nope' as json");
  assert.match(message, /^Not valid JSON/);
});

test("property access", async () => {
  assert.deepEqual(await output("print {a: {b: 2}}.a.b print [5, 6][1] print 'abc'.length"), ["2", "6", "3"]);
});

test("missing properties and variables are null", async () => {
  assert.deepEqual(await output("print {}.a print x print x's y"), ["null", "null", "null"]);
});

test("JavaScript internals are not visible", async () => {
  assert.deepEqual(
    await output("print {}.constructor print [].push print 'a'.constructor print {}.__proto__"),
    ["null", "null", "null", "null"],
  );
});

test("a field named __proto__ is only a field", async () => {
  assert.deepEqual(await output("print {__proto__: 1}.__proto__"), ["1"]);
});

test("if", async () => {
  assert.deepEqual(await output("if 1 < 2 print 'yes' end if [] print 'no' end"), ["yes"]);
});

test("tool calls set the result", async () => {
  const tools = { host_tool: async () => ({ code: 0, output: "ok" }) };
  assert.deepEqual(await output("host_tool print the result's code", { tools }), ["0"]);
});

test("parse errors stop the script before it runs", async () => {
  const result = await run("print 1\nprint 1 +");
  assert.deepEqual(result.output, []);
  assert.equal(result.errors.length, 1);
});

test("a runtime error stops the script", async () => {
  const result = await run("print 1\nprint 1 / 0\nprint 2");
  assert.deepEqual(result.output, ["1"]);
  assert.equal(result.errors.length, 1);
});

test("the step budget stops a script", async () => {
  const result = await run("print 1 print 2 print 3", { maxSteps: 2 });
  assert.deepEqual(result.output, ["1", "2"]);
  assert.deepEqual(result.errors.map((e) => e.message), ["Step budget of 2 used up"]);
});

test("steps are counted", async () => {
  const result = await run("print 1 if true print 2 end");
  assert.equal(result.steps, 3);
});

test('else runs when the condition is false', async () => {
  assert.deepEqual(await output(`if 1 > 2\n  print 'a'\nelse\n  print 'b'\nend`), ['b']);
  assert.deepEqual(await output(`if 1 < 2\n  print 'a'\nelse\n  print 'b'\nend`), ['a']);
});

test('else if chains need only one end', async () => {
  const chain = (n) => 'set n to ' + n + `\nif n is 1\n  print 'one'\nelse if n is 2\n  print 'two'\nelse\n  print 'many'\nend`;
  assert.deepEqual(await output(chain(1)), ['one']);
  assert.deepEqual(await output(chain(2)), ['two']);
  assert.deepEqual(await output(chain(3)), ['many']);
});

test('break in an else passes up to the loop', async () => {
  assert.deepEqual(await output(`for x in [1, 2, 3]\n  if x < 2\n    print x\n  else\n    break\n  end\nend`), ['1']);
});

test('a stray else is an error', async () => {
  assert.deepEqual(await errors('else'), [`Unexpected 'else' @1:1`]);
  assert.deepEqual((await errors(`for x in [1]\nelse\nend`))[0], `Expected 'end' for the 'for' at line 1 @2:1`);
});

test('on error with continue goes on after the failed command', async () => {
  assert.deepEqual(await output(`print 1\nprint 1 / 0\nprint 2\non error\n  print 'oops: ' + the error's message\n  continue\nend`), ['1', 'oops: Division by zero', '2']);
});

test('on error can be anywhere, and covers the whole script', async () => {
  assert.deepEqual(await output(`on error\n  continue\nend\nprint 1 / 0\nprint 'after'`), ['after']);
});

test('on error stops by default, with the error', async () => {
  const result = await run(`print 1 / 0\nprint 'never'\non error\n  print 'cleanup'\nend`);
  assert.deepEqual(result.output, ['cleanup']);
  assert.deepEqual(result.errors.map((e) => e.message), ['Division by zero']);
  assert.equal(result.status, 'failed');
});

test('stop ends the script with the error', async () => {
  const result = await run(`print 1 / 0\non error\n  stop\nend`);
  assert.equal(result.status, 'failed');
});

test('the error knows its line', async () => {
  assert.deepEqual(await output(`print 1\nprint 1 / 0\non error\n  print the error's line\n  continue\nend`), ['1', '2']);
});

test('continue in a loop goes on with the next command in the loop', async () => {
  assert.deepEqual(await output(`for x in [1, 0, 2]\n  print 6 / x\nend\non error\n  continue\nend`), ['6', '3']);
});

test('an error in on error is not handled again', async () => {
  const result = await run(`print 1 / 0\non error\n  print 2 / 0\n  continue\nend`);
  assert.deepEqual(result.errors.map((e) => e.message), ['Division by zero']);
  assert.equal(result.errors[0].line, 3);
});

test('the step budget is not handled', async () => {
  const result = await run(`repeat while true\nend\non error\n  continue\nend`, { maxSteps: 20 });
  assert.equal(result.errors[0].message, 'Step budget of 20 used up');
});

test('on error rules', async () => {
  assert.deepEqual(await errors(`if true\n  on error\n  end\nend`), [`'on error' must be at the top level of a script or tool @2:3`]);
  assert.deepEqual(await errors(`on error\nend\non error\nend`), [`Only one 'on error' is allowed in a script or tool @3:1`]);
  assert.deepEqual(await errors(`stop`), [`'stop' is only allowed in 'on error' @1:1`]);
  assert.deepEqual(await errors(`on error\n  for x in [1]\n    stop\n  end\nend`), [`'stop' is only allowed in 'on error' @3:5`]);
});

test('<name> of <value> is the same as <value>\'s <name>', async () => {
  assert.deepEqual(await output(`print length of 'abc'\nset x to {a: {b: 2}}\nprint b of a of x\nprint the b of x's a`), ['3', '2', '2']);
});

test('text has lines, as a file does', async () => {
  assert.deepEqual(await output(`for line in lines of 'a\\nb'\n  print line.number + ': ' + line\nend\nset t to 'x\\ny\\n'\nprint the length of t's lines`), ['1: a', '2: b', '2']);
});

test('a $ global before of is not a property', async () => {
  assert.deepEqual((await errors(`set $x to 1\nprint $x of 2`))[0], `Unknown command 'of' @2:10`);
});

test('first and last of a list, and of text', async () => {
  assert.deepEqual(await output(`set x to [1, 2, 3]\nprint first of x\nprint x's last\nprint last of 'a\\nb\\n'\nprint first of []\nset y to {first: 9}\nprint y's first`), ['1', '3', 'b', 'null', '9']);
});
