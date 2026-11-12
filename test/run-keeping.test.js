import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "../src/js/clank-talk.js";

// run ... keeping: which lines of a program's output a tool gives back; see src/md/features/sandbox-run.md

const NODE = process.execPath;
const TEN = "for (let n = 1; n <= 10; n++) console.log((n % 3 === 0 ? 'FAIL ' : 'ok ') + n)";
const BIG = "for (let n = 0; n < 50; n++) console.log('x'.repeat(100))";
let root;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "clank-keeping-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function outputOf(keeping) {
  await fs.writeFile(path.join(root, "AGENTS.talk"), `tool ten\n  run '${NODE}' with '-e', "${TEN}" ${keeping}\nend`);
  const result = await run("ten\nprint it's output", { root });
  assert.deepEqual(result.errors, []);
  return result.output[0];
}

test("keeping the first, the last, or both, with one line in place of the cut lines", async () => {
  const cut = (n) => "... " + n + " lines cut (all lines: the result's full) ...";
  assert.equal(await outputOf("keeping the first 2 lines"), "ok 1\nok 2\n" + cut(8) + "\n");
  assert.equal(await outputOf("keeping the last 2 lines"), cut(8) + "\nFAIL 9\nok 10\n");
  assert.equal(await outputOf("keeping the first 1 and the last 1 lines"), "ok 1\n" + cut(8) + "\nok 10\n");
  assert.equal(await outputOf("keeping the last 20 lines"), "ok 1\nok 2\nFAIL 3\nok 4\nok 5\nFAIL 6\nok 7\nok 8\nFAIL 9\nok 10\n");
});

test("keeping lines matching a pattern", async () => {
  assert.equal(await outputOf("keeping lines matching pattern /^FAIL/"), "FAIL 3\nFAIL 6\nFAIL 9\n... 7 other lines cut (all lines: the result's full) ...\n");
});

test("the result's full has all the lines, and or <n> KB cuts by size too", async () => {
  await fs.writeFile(path.join(root, "AGENTS.talk"), `tool ten\n  run '${NODE}' with '-e', "${TEN}" keeping the last 1 lines\nend`);
  const result = await run("ten\nprint length of lines of it's full", { root });
  assert.deepEqual(result.output, ["10"]);
  await fs.writeFile(path.join(root, "AGENTS.talk"), `tool big\n  run '${NODE}' with '-e', "${BIG}" keeping the last 50 lines or 1 KB\nend`);
  const big = await run("big\nprint it's output", { root });
  assert.deepEqual(big.errors, []);
  assert.ok(Buffer.byteLength(big.output[0]) < 1200);
  assert.match(big.output[0], /^\.\.\. \d+ lines cut/);
});

test("keeping is the last part of run; bad forms are clear errors", async () => {
  await fs.writeFile(path.join(root, "AGENTS.talk"), `allow env PATH\ntool ten\n  run '${NODE}' with '-e', "${TEN}" in a sandbox with network, writes to './tmp' within 1 minute keeping the last 1 lines\nend`);
  const sandboxed = await run("ten\nprint it's output", { root });
  if (sandboxed.errors.length === 0) {
    assert.equal(sandboxed.output[0], "... 9 lines cut (all lines: the result's full) ...\nok 10\n");
  } else {
    assert.doesNotMatch(sandboxed.errors[0].message, /^Expected/);
  }
  await fs.writeFile(path.join(root, "AGENTS.talk"), `tool ten\n  run '${NODE}' with '-e', '1' keeping the middle lines\nend`);
  assert.match((await run("print 1", { root })).errors[0].message, /^Expected 'the first', 'the last' or 'lines matching'/);
  await fs.writeFile(path.join(root, "AGENTS.talk"), `tool ten\n  run '${NODE}' with '-e', '1' keeping lines matching 'FAIL'\nend`);
  assert.match((await run("ten", { root })).errors[0].message, /^keeping lines matching needs a pattern/);
});
