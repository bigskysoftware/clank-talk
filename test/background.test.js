import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run, stopAllProcesses } from "../src/js/clank-talk.js";

// one project, and one session of processes for all tests
let root;
const processes = new Map();

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "clank-bg-"));
  // a server that prints, then waits; and a program that ends at once
  await fs.writeFile(path.join(root, "server.js"), "console.log('ready'); setInterval(() => {}, 1000);");
  await fs.writeFile(path.join(root, "quick.js"), "console.log('done'); process.exit(3);");
  await fs.writeFile(path.join(root, "AGENTS.talk"), [
    "allow env PATH",
    "tool serve",
    "  start 'node' with 'server.js' as 'site'",
    "end",
    "tool quick",
    "  start 'node quick.js' as 'quick'",
    "end",
  ].join("\n"));
});

after(async () => {
  stopAllProcesses(processes);
  await fs.rm(root, { recursive: true, force: true });
});

async function output(source) {
  const result = await run(source, { root, processes });
  assert.deepEqual(result.errors, []);
  return result.output;
}

async function errors(source) {
  const result = await run(source, { root, processes });
  return result.errors.map((e) => e.message);
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("start a server in a tool, look at it, and stop it from a script", async () => {
  assert.deepEqual(await output("serve\nprint it"), ["site: running"]);
  await pause(300);
  assert.deepEqual(await output("print the output of process 'site'\nprint the status of process 'site'"), ["ready\n", "running"]);
  assert.deepEqual(await errors("serve"), ["Process 'site' is already running. Stop it first"]);
  assert.deepEqual(await output("stop process 'site'\nprint it\nprint the processes"), ["site: stopped", "site: stopped"]);
});

test("a program that ends has its exit code", async () => {
  await output("quick");
  await pause(300);
  assert.deepEqual(await output("print process 'quick'\nprint the code of process 'quick'"), ["quick: exited (code 3)", "3"]);
  assert.deepEqual(await output("print the processes"), ["quick: exited (code 3)\nsite: stopped"]);
});

test("rules", async () => {
  assert.deepEqual(await errors("start 'node' as 'x'"), ["'start' is only allowed in a tool"]);
  assert.deepEqual(await errors("stop process 'nope'"), ["No process named 'nope'"]);
  assert.deepEqual(await output("print process 'nope'"), ["null"]);
});
