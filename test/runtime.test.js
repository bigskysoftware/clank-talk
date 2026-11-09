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
  assert.deepEqual(await output("print [1] as json"), ["[\n  1\n]"]);
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
  const tools = { run_tests: async () => ({ code: 0, output: "ok" }) };
  assert.deepEqual(await output("run_tests print the result's code", { tools }), ["0"]);
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
