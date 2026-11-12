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
  assert.deepEqual(await output("set nothing to null\nfor x in nothing print x end print 'done'"), ["done"]);
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

test("a one-line if needs its end on the same line", async () => {
  const message = "A one-line if needs 'end' on the same line: if <condition> then <command> end. For more lines, put the commands on the lines after the if";
  // one error, at the if; the for still has its end
  assert.deepEqual(await errors("for l in [1, 2]\n  if l > 1 then print l\nend"), [message]);
  assert.deepEqual(await errors("if true then print 1\nend"), [message]);
  assert.deepEqual(await output("for l in [1, 2]\n  if l > 1 then print l end\nend"), ["2"]);
  assert.deepEqual(await output("if true then\n  print 1\nend"), ["1"]);
  assert.deepEqual(await output("if true print 1 then print 2 end"), ["1", "2"]);
});

test("replace warns when its old text is a quoted string on more than one line that lost its indent", async () => {
  const result = await run("set t to '    a,\\n    b'\nreplace '    a,\n    b' with 'x' in t\nprint t");
  assert.deepEqual(result.warnings.map((warning) => warning.message), ["The old text is a quoted string on more than one line, so the indent its lines share was removed. For code, use a text block (| lines)", "No match in the variable for 'a,\nb'"]);
  // a text block keeps the spaces, and gives no warning
  const block = await run("set t to '    a,\\n    b'\nreplace\n|     a,\n|     b\nwith 'x' in t\nprint t");
  assert.deepEqual(block.warnings, []);
  assert.deepEqual(block.output, ["x"]);
});

test("lines of lines, such as from find, are the same lines", async () => {
  const result = await run("set t to 'a\\nb x\\nc x'\nset hits to find 'x' in t\nset again to lines of hits\nprint again\nprint again's length");
  assert.deepEqual(result.output, ["2: b x\n3: c x", "2"]);
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
