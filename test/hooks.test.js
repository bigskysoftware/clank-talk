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
  await agentsTalk("before change\n  if the change's path ends with '.cfg'\n    reject 'no ' + the change's kind\n  end\nend");
  await fs.writeFile(path.join(root, "prod.cfg"), "A=1\n");
  const cases = [
    ["write 'x' to ./prod.cfg", "no write"],
    ["append 'x' to ./prod.cfg", "no append"],
    ["replace 'A' with 'B' in ./prod.cfg", "no replace"],
    ["read ./prod.cfg\nput 'x' before line 1 of ./prod.cfg", "no put"],
    ["read ./prod.cfg\nremove lines 1 to 1 of ./prod.cfg", "no remove"],
    ["read ./prod.cfg\nreplace lines 1 to 1 of ./prod.cfg with 'y'", "no replace"],
    ["move ./prod.cfg to ./other.txt", "no move"],
    ["delete ./prod.cfg", "no delete"],
  ];
  for (const [source, message] of cases) {
    const [e] = await errors(source);
    assert.equal(e.message, message, source);
  }
  assert.equal(await fs.readFile(path.join(root, "prod.cfg"), "utf8"), "A=1\n");
});

test("is in a folder checks the path, not the text: the migrations hook", async () => {
  await agentsTalk("before change\n  if the change's path is in @/migrations/\n    reject 'A human writes the migrations'\n  end\nend");
  await fs.mkdir(path.join(root, "migrations", "old"), { recursive: true });
  assert.deepEqual((await errors("write 'x' to @/migrations/001.sql")).map((e) => e.message), ["A human writes the migrations"]);
  assert.deepEqual((await errors("write 'x' to @/migrations/old/002.sql")).map((e) => e.message), ["A human writes the migrations"]);
  assert.deepEqual(await output("write 'x' to @/migrations-notes.txt"), []);
  assert.deepEqual(await output("write 'x' to @/src.sql"), []);
});

test("is in a folder: files, text paths, a folder that exists, and is not in", async () => {
  await fs.mkdir(path.join(root, "src", "lib"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "lib", "a.js"), "");
  const checks = [
    "print @/src/lib/a.js is in @/src/",
    "print 'src/lib/a.js' is in @/src/",
    "print 'src/lib/a.js' is in @/src",
    "print 'srcx/a.js' is in @/src/",
    "print 'src' is in @/src/",
    "print 'src/lib/a.js' is not in @/src/",
    "print null is in @/src/",
    "print @/src/**/*.js",
  ];
  assert.deepEqual(await output(checks.join("\n")), ["true", "true", "true", "false", "false", "false", "false", '["src/lib/a.js"]']);
  assert.match((await errors("print 3 is in @/src/"))[0].message, /^'is in' a folder needs a path or a file, found /);
});

test("after hooks see the step and the result", async () => {
  await agentsTalk("after write\n  print 'wrote ' + the write's path\nend\nafter run_tests\n  print 'code ' + the result's code\nend\ntool run_tests\n  set the result to {code: 0}\nend");
  assert.deepEqual(await output("write 'x' to ./a.txt\nrun_tests"), ["wrote a.txt", "code 0"]);
});

test("before run sees the program and its arguments", async () => {
  await agentsTalk(`allow env PATH\nbefore run\n  if the run's args contains '--force'\n    reject 'no force'\n  end\nend\ntool go with flag\n  run '${NODE}' with '-e', '1', '--', flag\nend`);
  const [e] = await errors("go '--force'");
  assert.equal(e.message, "no force");
  assert.deepEqual(await output("go 'safe'\nprint it.code"), ["0"]);
});

test("a hook gets a copy of the step, so it cannot change the program's arguments", async () => {
  await agentsTalk(`allow env PATH\nbefore run\n  set the run's args[3] to '--changed'\nend\ntool go with word\n  run '${NODE}' with '-e', 'console.log(process.argv[1])', '--', word\nend`);
  assert.deepEqual(await output("go 'safe'\nprint it.output"), ["safe\n"]);
});

test("a hook for a tool reads the step as the <tool>'s args", async () => {
  await agentsTalk("before deploy\n  if the deploy's args contains 'prod'\n    reject 'no prod'\n  end\nend\ntool deploy with target\n  set the result to target\nend");
  const [e] = await errors("deploy 'prod'");
  assert.equal(e.message, "no prod");
  assert.deepEqual(await output("deploy 'dev'\nprint it"), ["dev"]);
});

test("reject in a tool stops the tool, and the caller gets the message at the call", async () => {
  await agentsTalk("tool deploy with target\n  if target is 'prod'\n    reject 'Not today, robot'\n  end\n  set the result to 'deployed ' + target\nend\ntool outer\n  deploy 'prod'\nend");
  assert.deepEqual(await errors("print 1\ndeploy 'prod'"), [{ message: "Not today, robot", line: 2, column: 1 }]);
  assert.deepEqual(await output("deploy 'dev'\nprint it"), ["deployed dev"]);
  assert.deepEqual(await errors("outer"), [{ message: "Not today, robot", line: 1, column: 1 }]);
  assert.deepEqual(await output("on error\n  print 'caught: ' + the error's message\n  continue\nend\ndeploy 'prod'"), ["caught: Not today, robot"]);
});

test("a hook for a tool reads each parameter by its name, by position or by name", async () => {
  await agentsTalk("before deploy\n  if the deploy's target is 'prod'\n    reject 'no prod: ' + the deploy's region\n  end\nend\ntool deploy with target, region\n  set the result to target\nend");
  assert.equal((await errors("deploy 'prod', 'eu'"))[0].message, "no prod: eu");
  assert.equal((await errors("deploy with region: 'us', target: 'prod'"))[0].message, "no prod: us");
  assert.equal((await errors("deploy 'prod'"))[0].message, "no prod: null");
  assert.deepEqual(await output("deploy 'dev'\nprint it"), ["dev"]);
  await agentsTalk("tool deploy with args\n  set the result to 1\nend");
  assert.match((await errors("print 1"))[0].message, /^A tool parameter cannot be named 'args'/);
});

test("a hook cannot call a tool that runs a program, also through another tool", async () => {
  await agentsTalk(`tool sh\n  run '${NODE}' with '-e', '1'\nend\ntool outer\n  sh\nend\ntool calm\n  set the result to 1\nend\nbefore write\n  outer\nend`);
  const [e] = await errors("write 'x' to ./a.txt");
  assert.match(e.message, /^A hook cannot call 'outer', because it runs a program/);
  // a tool that runs no program is fine in a hook
  await agentsTalk("tool calm\n  set the result to 1\nend\nbefore write\n  calm\nend");
  assert.deepEqual(await output("write 'x' to ./a.txt"), []);
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
  assert.equal((await errors("print 1"))[0].message, "Unknown step 'banana' for a hook. Use read, write, append, replace, put, remove, move, delete, change, undo, run, git, fetch, start, stop, or a tool name");
  await agentsTalk("after write\n  reject 'x'\nend");
  assert.equal((await errors("print 1"))[0].message, "'reject' is only allowed in a 'before' hook or a tool");
  assert.equal((await errors("reject 'x'"))[0].message, "'reject' is only allowed in a 'before' hook or a tool");
});
