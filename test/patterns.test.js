import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "../src/js/clank-talk.js";

let root;
const LOG = "ok 1 first\nnot ok 2 second\nok 3 third\nnot ok 4 fourth\n";

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "clank-patterns-"));
  await fs.writeFile(path.join(root, "log.txt"), LOG);
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function result(source) {
  return await run(source, { root });
}

async function output(source) {
  const done = await result(source);
  assert.deepEqual(done.errors, []);
  return done.output;
}

async function errors(source) {
  return (await result(source)).errors.map((e) => e.message);
}

test("find pattern gives the lines that match", async () => {
  assert.deepEqual(await output("print find pattern '^not ok' in ./log.txt"), ["log.txt:2: not ok 2 second\nlog.txt:4: not ok 4 fourth"]);
  assert.deepEqual(await output("set hits to find pattern '(first|third)$' in ./log.txt\nprint hits's length"), ["2"]);
  assert.deepEqual(await output("print find pattern 'b+' in 'abc\\nxyz'"), ["1: abc"]);
});

test("replace pattern can use back references", async () => {
  assert.deepEqual(await output(`set t to '2026-11-09'\nreplace pattern """(\\d+)-(\\d+)-(\\d+)""" with '$3.$2.$1' in t\nprint t`), ["09.11.2026"]);
  assert.deepEqual(await output(`set t to 'Ada Lovelace'\nreplace pattern """(?<first>\\w+) (?<last>\\w+)""" with '$<last>, $<first> ($&) $$5' in t\nprint t`), ["Lovelace, Ada (Ada Lovelace) $5"]);
  const done = await result(`replace pattern """ok (\\d)""" with 'OK-$1' in ./log.txt\nprint the result's length`);
  assert.deepEqual(done.errors, []);
  assert.deepEqual(done.output, ["4"]);
  assert.equal(await fs.readFile(path.join(root, "log.txt"), "utf8"), "OK-1 first\nnot OK-2 second\nOK-3 third\nnot OK-4 fourth\n");
  await fs.writeFile(path.join(root, "log.txt"), LOG);
});

test("matches checks text against a pattern", async () => {
  assert.deepEqual(await output(`if 'v1.20' matches pattern """^v\\d+\\.\\d+$"""\n  print 'a version'\nend`), ["a version"]);
  assert.deepEqual(await output("print 'main' matches pattern '^v'"), ["false"]);
  assert.deepEqual(await errors("print 'x' matches 'x'"), ["matches needs a pattern, such as: matches pattern '^v[0-9]+', found 'x'"]);
});

test("a bad pattern, and no match", async () => {
  assert.match((await errors("find pattern '(' in ./log.txt"))[0], /^Not a valid pattern: /);
  const done = await result("set t to 'abc'\nreplace pattern 'z+' with 'y' in t");
  assert.deepEqual(done.warnings.map((w) => w.message), ["No match in the variable for pattern 'z+'"]);
});

test("a runaway pattern is stopped, and the next pattern still works", async () => {
  const slow = "a".repeat(40) + "!";
  assert.deepEqual(await errors(`print '${slow}' matches pattern '^(a+)+$'`), ["The pattern ran for more than 2 seconds, so it was stopped. A pattern such as (a+)+ can run for a very long time. Make it simpler"]);
  assert.deepEqual(await output("print 'b' matches pattern 'b'"), ["true"]);
});

test("pattern alone is still a plain word", async () => {
  assert.deepEqual(await output("set pattern to 5\nprint pattern"), ["5"]);
});
