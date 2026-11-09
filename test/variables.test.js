import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/js/clank-talk.js";

async function output(source, options) {
  const result = await run(source, options);
  assert.deepEqual(result.errors, []);
  return result.output;
}

async function errors(source, options) {
  const result = await run(source, options);
  return result.errors.map((e) => e.message);
}

test("set and read a variable", async () => {
  assert.deepEqual(await output("set x to 1 print x"), ["1"]);
});

test("set a variable to an expression", async () => {
  assert.deepEqual(await output("set x to 2 set y to x + 1 print y"), ["3"]);
});

test("set a property", async () => {
  assert.deepEqual(await output("set config to {version: 1}\nset config's version to 2\nprint config.version"), ["2"]);
});

test("set an index", async () => {
  assert.deepEqual(await output("set x to [1, 2]\nset x[0] to 9\nprint x"), ["[9,2]"]);
});

test("set a field named __proto__ makes a plain field", async () => {
  assert.deepEqual(await output("set x to '{}' as json\nset x's __proto__ to 1\nprint x.__proto__"), ["1"]);
});

test("set on null is an error", async () => {
  assert.deepEqual(await errors("set x's y to 1"), ["Cannot set 'y' on null"]);
});

test("set a field that cannot change is an error", async () => {
  assert.deepEqual(await errors("set x to [1]\nset x.length to 0"), ["Cannot set 'length'"]);
});

test("set needs a variable or property", async () => {
  assert.deepEqual(await errors("set 1 to 2"), ["Cannot set this, expected a variable or a property"]);
  assert.deepEqual(await errors("set it to 2"), ["Cannot set this, expected a variable or a property"]);
});

test("set needs 'to'", async () => {
  assert.deepEqual(await errors("set x 1"), ["Expected 'to'"]);
});

test("increment by an amount", async () => {
  assert.deepEqual(await output("set total to 1\nincrement total by 2\nprint total"), ["3"]);
});

test("increment a property", async () => {
  assert.deepEqual(await output("set item to {count: 1}\nincrement item's count by 1\nprint item.count"), ["2"]);
});

test("increment starts an unset variable at 0", async () => {
  assert.deepEqual(await output("increment total by 5 print total"), ["5"]);
});

test("increment with no 'by' adds 1", async () => {
  assert.deepEqual(await output("set x to 1\nincrement x\nprint x"), ["2"]);
});

test("decrement", async () => {
  assert.deepEqual(await output("set x to 5\ndecrement x\ndecrement x by 2\nprint x"), ["2"]);
});

test("decrement starts an unset variable at 0", async () => {
  assert.deepEqual(await output("decrement x print x"), ["-1"]);
});

test("increment needs a number", async () => {
  assert.deepEqual(await errors("set x to 'a'\nincrement x by 1"), ["Expected a number, found 'a'"]);
});

test("local variables do not stay between runs", async () => {
  await output("set x to 1");
  assert.deepEqual(await output("print x"), ["null"]);
});

test("$ globals stay when the host passes the same globals object", async () => {
  const globals = {};
  await output("set $last to 'build ok'", { globals });
  assert.deepEqual(await output("print $last", { globals }), ["build ok"]);
});

test("$x and x are different variables", async () => {
  assert.deepEqual(await output("set x to 1 set $x to 2 print x print $x"), ["1", "2"]);
});
