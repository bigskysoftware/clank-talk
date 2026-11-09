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

test("for over a list", async () => {
  assert.deepEqual(await output("for x in [1, 2, 3]\n  print x\nend"), ["1", "2", "3"]);
});

test("for with index, both forms", async () => {
  assert.deepEqual(await output("for x in ['a', 'b'] index i\n  print i + x\nend"), ["0a", "1b"]);
  assert.deepEqual(await output("for x in ['a', 'b'] with index i\n  print i + x\nend"), ["0a", "1b"]);
});

test("for over null makes no passes", async () => {
  assert.deepEqual(await output("for x in nothing print x end print 'done'"), ["done"]);
});

test("for over something else is an error", async () => {
  assert.deepEqual(await errors("for x in 5 print x end"), ["Cannot loop over 5, expected a list"]);
});

test("repeat times", async () => {
  assert.deepEqual(await output("repeat 3 times index i\n  print i\nend"), ["0", "1", "2"]);
});

test("repeat while", async () => {
  assert.deepEqual(await output("set n to 0\nrepeat while n < 2\n  increment n\nend\nprint n"), ["2"]);
});

test("repeat until", async () => {
  assert.deepEqual(await output("set n to 0\nrepeat until n is 3\n  increment n\nend\nprint n"), ["3"]);
});

test("break", async () => {
  assert.deepEqual(await output("for x in [1, 2, 3]\n  if x is 2 break end\n  print x\nend"), ["1"]);
});

test("continue", async () => {
  assert.deepEqual(await output("for x in [1, 2, 3]\n  if x is 2 continue end\n  print x\nend"), ["1", "3"]);
});

test("break only leaves the inner loop", async () => {
  const source = "for a in [1, 2]\n  for b in [1, 2]\n    break\n  end\n  print a\nend";
  assert.deepEqual(await output(source), ["1", "2"]);
});

test("break and continue outside a loop are errors", async () => {
  assert.deepEqual(await errors("break"), ["'break' is only allowed in a loop"]);
  assert.deepEqual(await errors("if true continue end"), ["'continue' is only allowed in a loop"]);
});

test("an endless empty loop stops at the step budget", async () => {
  assert.deepEqual(await errors("repeat while true end", { maxSteps: 50 }), ["Step budget of 50 used up"]);
});

test("each pass counts as a step", async () => {
  const result = await run("repeat 3 times end");
  assert.equal(result.steps, 4);
});

test("missing parts are errors", async () => {
  assert.deepEqual((await errors("for x [1] end"))[0], "Expected 'in'");
  assert.deepEqual((await errors("repeat 3 print 1 end"))[0], "Expected 'times', 'while' or 'until'");
  assert.deepEqual((await errors("for x in [1] with i end"))[0], "Expected 'index'");
  assert.deepEqual((await errors("for x in [1]\nprint x"))[0], "Expected 'end' for the 'for' at line 1");
});
