import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "../src/js/clank-talk.js";

const NODE = process.execPath;
let root;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "clank-hooks-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function agentsTalk(source) {
  return fs.writeFile(path.join(root, "AGENTS.talk"), source);
}

async function output(source) {
  const result = await run(source, { root });
  assert.deepEqual(result.errors, []);
  return result.output;
}

async function errors(source) {
  return (await run(source, { root })).errors;
}

test("a before hook can reject a write", async () => {
  await agentsTalk("before write\n  if the write's path ends with '.env'\n    reject 'Cannot update env files!'\n  end\nend");
  assert.deepEqual(await errors("write 'x' to ./.env"), [{ message: "Cannot update env files!", line: 1, column: 1 }]);
  await assert.rejects(fs.stat(path.join(root, ".env")));
  assert.deepEqual(await output("write 'x' to ./ok.txt"), []);
});

test("change covers every kind of file change", async () => {
  await agentsTalk("before change\n  if the change's path ends with '.env'\n    reject 'no ' + the change's kind\n  end\nend");
  await fs.writeFile(path.join(root, ".env"), "A=1\n");
  const cases = [
    ["write 'x' to ./.env", "no write"],
    ["append 'x' to ./.env", "no append"],
    ["replace 'A' with 'B' in ./.env", "no replace"],
    ["read ./.env\nput 'x' before line 1 of ./.env", "no put"],
    ["read ./.env\nremove lines 1 to 1 of ./.env", "no remove"],
    ["read ./.env\nreplace lines 1 to 1 of ./.env with 'y'", "no replace"],
  ];
  for (const [source, message] of cases) {
    const [e] = await errors(source);
    assert.equal(e.message, message, source);
  }
  assert.equal(await fs.readFile(path.join(root, ".env"), "utf8"), "A=1\n");
});

test("after hooks see the step and the result", async () => {
  await agentsTalk("after write\n  print 'wrote ' + the write's path\nend\nafter run_tests\n  print 'code ' + the result's code\nend\ntool run_tests\n  set the result to {code: 0}\nend");
  assert.deepEqual(await output("write 'x' to ./a.txt\nrun_tests"), ["wrote a.txt", "code 0"]);
});

test("before run sees the program and its arguments", async () => {
  await agentsTalk(`allow env PATH\nbefore run\n  if the run's args contains '--force'\n    reject 'no force'\n  end\nend\ntool go with flag\n  run '${NODE}' with '-e', '1', flag\nend`);
  const [e] = await errors("go '--force'");
  assert.equal(e.message, "no force");
  assert.deepEqual(await output("go 'safe'\nprint it.code"), ["0"]);
});

test("before read", async () => {
  await agentsTalk("before read\n  if the read's path is 'secret.txt'\n    reject 'no peeking'\n  end\nend");
  await fs.writeFile(path.join(root, "secret.txt"), "shh");
  const [e] = await errors("print ./secret.txt's text");
  assert.equal(e.message, "no peeking");
});

test("on error can catch a reject", async () => {
  await agentsTalk("before write\n  reject 'read only'\nend");
  assert.deepEqual(await output("write 'x' to ./a.txt\non error\n  print the error's message\n  continue\nend"), ["read only"]);
});

test("commands in a hook do not run hooks", async () => {
  await agentsTalk("before write\n  write 'log' to ./log.txt\nend");
  assert.deepEqual(await output("write 'x' to ./a.txt"), []);
  assert.equal(await fs.readFile(path.join(root, "log.txt"), "utf8"), "log");
});

test("hooks run for commands inside tools", async () => {
  await agentsTalk("before write\n  reject 'no writes'\nend\ntool save\n  write 'x' to ./a.txt\nend");
  const [e] = await errors("save");
  assert.equal(e.message, "no writes");
});

test("errors in a hook point at AGENTS.talk", async () => {
  await agentsTalk("before write\n  print 1 / 0\nend");
  const [e] = await errors("write 'x' to ./a.txt");
  assert.deepEqual(e, { message: "Division by zero", line: 2, column: 11, file: "AGENTS.talk" });
});

test("hook rules", async () => {
  await agentsTalk("before banana\nend");
  assert.equal((await errors("print 1"))[0].message, "Unknown step 'banana' for a hook. Use read, write, append, replace, put, remove, change, run, or a tool name");
  await agentsTalk("after write\n  reject 'x'\nend");
  assert.equal((await errors("print 1"))[0].message, "'reject' is only allowed in a 'before' hook");
  assert.equal((await errors("reject 'x'"))[0].message, "'reject' is only allowed in a 'before' hook");
});
