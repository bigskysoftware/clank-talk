import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run, start } from "../src/js/clank-talk.js";

// the tests run node itself, by its full path, so they do not depend on PATH
const NODE = process.execPath;
let root;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "clank-run-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function agentsTalk(source) {
  return fs.writeFile(path.join(root, "AGENTS.talk"), source);
}

async function result(source, options = {}) {
  return await run(source, { root, ...options });
}

async function output(source, options = {}) {
  const r = await result(source, options);
  assert.deepEqual(r.errors, []);
  return r.output;
}

test("run gives back the exit code and the output", async () => {
  await agentsTalk(`tool hello\n  run '${NODE}' with '-e', 'console.log("hi")'\nend`);
  assert.deepEqual(await output("hello\nprint it.code\nprint it.output"), ["0", "hi\n"]);
});

test("a failing program is not an error: check the code", async () => {
  await agentsTalk(`tool fail\n  run '${NODE}' with '-e', 'console.error("bad"); process.exit(3)'\nend`);
  assert.deepEqual(await output("fail\nif the result's code is not 0\n  print the result's output\nend"), ["bad\n"]);
});

test("one string splits on spaces", async () => {
  await agentsTalk(`tool version\n  run '${NODE} --version'\nend`);
  const [code] = await output("version\nprint it.code");
  assert.equal(code, "0");
});

test("arguments from the agent are never shell text", async () => {
  await agentsTalk(`tool echo with text\n  run '${NODE}' with '-e', 'console.log(process.argv[1])', text\nend`);
  assert.deepEqual(await output("echo '; rm -rf / $(whoami)'\nprint it.output"), ["; rm -rf / $(whoami)\n"]);
});

test("run is not allowed in a script", async () => {
  const r = await result("run 'ls'");
  assert.equal(r.errors[0].message, "'run' is only allowed in a tool");
});

test("a missing program is an error", async () => {
  await agentsTalk("tool nope\n  run 'no-such-program-xyz'\nend");
  const r = await result("nope");
  assert.equal(r.errors[0].message, "Cannot run 'no-such-program-xyz': program not found");
});

test("the environment is empty, apart from allow env", async () => {
  process.env.CLANK_ALLOWED = "yes";
  process.env.CLANK_SECRET = "no";
  const script = 'console.log(Object.keys(process.env).filter(k => k.startsWith("CLANK")).join(","))';
  await agentsTalk(`allow env CLANK_ALLOWED\ntool env\n  run '${NODE}' with '-e', '${script}'\nend`);
  assert.deepEqual(await output("env\nprint it.output"), ["CLANK_ALLOWED\n"]);
  delete process.env.CLANK_ALLOWED;
  delete process.env.CLANK_SECRET;
});

test("within on run stops a slow program", async () => {
  await agentsTalk(`tool slow\n  run '${NODE}' with '-e', 'setTimeout(() => {}, 10000)' within 100ms\nend`);
  const r = await result("slow");
  assert.equal(r.errors[0].message, `'${NODE}' did not finish within 100ms`);
});

test("within on a tool call stops a slow program", async () => {
  await agentsTalk(`tool slow\n  run '${NODE}' with '-e', 'setTimeout(() => {}, 10000)'\nend`);
  const r = await result("slow within 100 ms");
  assert.match(r.errors[0].message, /did not finish within 100ms$/);
});

test("the shorter limit wins", async () => {
  await agentsTalk(`tool slow\n  run '${NODE}' with '-e', 'setTimeout(() => {}, 10000)' within 50ms\nend`);
  const r = await result("slow within 10 minutes");
  assert.match(r.errors[0].message, /did not finish within 50ms$/);
});

test("durations", async () => {
  await agentsTalk(`tool quick\n  run '${NODE}' with '-e', '1' within 2 seconds\nend`);
  assert.deepEqual(await output("quick within 1 minute\nprint it.code"), ["0"]);
});

test("a duration needs a unit", async () => {
  await agentsTalk("tool a\nend");
  const r = await result("a within 5");
  assert.equal(r.errors[0].message, "Expected a time unit: ms, s, seconds, minutes or hours");
});

test("cancel stops a running program", async () => {
  await agentsTalk(`tool slow\n  run '${NODE}' with '-e', 'setTimeout(() => {}, 10000)'\nend`);
  const execution = start("slow", { root });
  setTimeout(() => execution.cancel(), 100);
  const r = await execution.done;
  assert.equal(r.status, "cancelled");
});

test("run uses the current directory", async () => {
  await fs.mkdir(path.join(root, "sub"));
  await agentsTalk(`tool where\n  run '${NODE}' with '-e', 'console.log(process.cwd())'\nend`);
  const [where] = await output("where\nprint it.output", { cwd: "sub" });
  assert.equal(await fs.realpath(where.trim()), await fs.realpath(path.join(root, "sub")));
});
