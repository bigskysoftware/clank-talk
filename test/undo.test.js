import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "../src/js/clank-talk.js";

// each test has its own project, and one undo list for a "session" of scripts
let root;
let undo;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "clank-undo-"));
  undo = [];
  await fs.writeFile(path.join(root, "a.txt"), "a\n");
  await fs.writeFile(path.join(root, "b.txt"), "b\n");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function readProject(name) {
  return fs.readFile(path.join(root, name), "utf8");
}

async function ok(source) {
  const result = await run(source, { root, undo });
  assert.deepEqual(result.errors, []);
  return result;
}

async function errors(source) {
  const result = await run(source, { root, undo });
  return result.errors.map((e) => e.message);
}

test("undo takes back the last script, from an earlier run", async () => {
  await ok("replace 'a' with 'A' in ./a.txt\nwrite 'new' to ./new.txt");
  const result = await ok("undo\nprint the result");
  assert.equal(await readProject("a.txt"), "a\n");
  await assert.rejects(fs.access(path.join(root, "new.txt")));
  assert.deepEqual(result.output, ['["a.txt","new.txt"]']);
  assert.deepEqual(await errors("undo"), ["Nothing to undo"]);
});

test("undo 2 takes back two scripts, newest first", async () => {
  await ok("write 'one' to ./a.txt");
  await ok("write 'two' to ./a.txt");
  await ok("write 'x' to ./b.txt");
  await ok("undo 2");
  assert.equal(await readProject("a.txt"), "one");
  assert.equal(await readProject("b.txt"), "b\n");
  assert.deepEqual(await errors("undo 5"), ["Only 1 scripts can be undone"]);
});

test("undo changes to one file", async () => {
  await ok("write 'A' to ./a.txt\nwrite 'B' to ./b.txt");
  await ok("undo changes to ./a.txt");
  assert.equal(await readProject("a.txt"), "a\n");
  assert.equal(await readProject("b.txt"), "B");
  assert.deepEqual(await errors("undo changes to ./a.txt"), ["Undo has no changes to a.txt"]);
  await ok("undo");
  assert.equal(await readProject("b.txt"), "b\n");
});

test("undo changes nothing if a file changed after the script", async () => {
  await ok("write 'A' to ./a.txt\nwrite 'B' to ./b.txt");
  await fs.writeFile(path.join(root, "a.txt"), "the human edited this");
  assert.deepEqual(await errors("undo"), ["Cannot undo: these files changed after the script: a.txt. Nothing was changed"]);
  assert.equal(await readProject("b.txt"), "B");
});

test("undo does not record itself, and a failed script can be undone", async () => {
  await ok("write 'A' to ./a.txt");
  await ok("undo");
  assert.deepEqual(await errors("undo"), ["Nothing to undo"]);
  await errors("write 'A' to ./a.txt\nprint 1 / 0");
  await ok("undo");
  assert.equal(await readProject("a.txt"), "a\n");
});

test("the undo list", async () => {
  await ok("write 'A' to ./a.txt");
  await ok("write 'B' to ./b.txt\nwrite 'C' to ./c.txt");
  const result = await ok("print the undo list\nprint the undo list's first's files");
  assert.match(result.output[0], /^1\. \d\d:\d\d  2 files: b.txt, c.txt\n2\. \d\d:\d\d  1 file: a.txt$/);
  assert.equal(result.output[1], '["b.txt","c.txt"]');
});

test("hooks can watch and reject undo", async () => {
  await ok("write 'A' to ./a.txt");
  await fs.writeFile(path.join(root, "AGENTS.talk"), "before undo\n  reject 'no undo here'\nend");
  assert.deepEqual(await errors("undo"), ["no undo here"]);
  assert.equal(await readProject("a.txt"), "A");
});
