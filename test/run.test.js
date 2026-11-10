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

test("a program that prints too much is stopped, so it cannot fill the server's memory", async () => {
  await agentsTalk(`tool big\n  run '${NODE}' with '-e', 'process.stdout.write("x".repeat(11 * 1024 * 1024))'\nend`);
  const r = await result("big");
  assert.equal(r.errors[0].message, `'${NODE}' gave more than 10 MB of output, so it was stopped. Make it print less, for example with a quieter reporter`);
});

test("a stop also stops the programs that the program started", { skip: process.platform === "win32" }, async () => {
  const script = 'const { spawn } = require("child_process"); const c = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" }); require("fs").writeFileSync("child.pid", String(c.pid)); setTimeout(() => {}, 10000)';
  await agentsTalk(`tool family\n  run '${NODE}' with '-e', '${script}' within 500ms\nend`);
  const r = await result("family");
  assert.match(r.errors[0].message, /did not finish within 500ms$/);
  const pid = Number(await fs.readFile(path.join(root, "child.pid"), "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
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

test("a sandbox grant must be a path written out, not a variable or a tool argument", async () => {
  await agentsTalk("tool copy with folder\n  run 'cat' with 'x' in a sandbox with reads of folder\nend");
  const r = await result("print 1");
  assert.equal(r.errors[0].message, "'reads of' needs a path written out, such as reads of '~/.m2'. It cannot come from a variable or a tool argument");
  await agentsTalk("tool copy with folder\n  run 'cat' with 'x' in a sandbox with writes to '${folder}'\nend");
  assert.match((await result("print 1")).errors[0].message, /^'writes to' needs a path written out/);
  await agentsTalk("tool ok\n  run 'cat' with 'x' in a sandbox with reads of '~/.m2', writes to @/out/\nend");
  assert.deepEqual((await result("print 1")).errors, []);
});

test("an argument from the agent must not start with '-'", async () => {
  await agentsTalk(`tool echo with text\n  run '${NODE}' with '-e', 'console.log(process.argv[1])', text\nend`);
  const r = await result("echo '--rulesdir=./evil'");
  assert.equal(r.errors[0].message, "The argument '--rulesdir=./evil' starts with '-', and it is not written out in AGENTS.talk. A program can read it as an option. If the program takes '--' to end its options, put '--' before the value in the tool");
});

test("after a written-out '--', an argument can start with '-'", async () => {
  await agentsTalk(`tool echo with text\n  run '${NODE}' with '-e', 'console.log(process.argv[1])', '--', text\nend`);
  assert.deepEqual(await output("echo '-x'\nprint it.output"), ["-x\n"]);
});

async function withPath(entry, body) {
  const saved = process.env.PATH;
  process.env.PATH = entry + path.delimiter + saved;
  try {
    await body();
  } finally {
    process.env.PATH = saved;
  }
}

async function fakeProgram(dir) {
  await fs.mkdir(path.join(root, dir), { recursive: true });
  const file = path.join(root, dir, "clank-fake");
  await fs.writeFile(file, "#!/bin/sh\necho fake\n");
  await fs.chmod(file, 0o755);
}

test("a program found through PATH inside the project is refused", { skip: process.platform === "win32" }, async () => {
  await fakeProgram("node_modules/.bin");
  await agentsTalk("allow env PATH\ntool go\n  run 'clank-fake'\nend\ntool go_path\n  run './node_modules/.bin/clank-fake'\nend");
  await withPath(path.join(root, "node_modules/.bin"), async () => {
    const r = await result("go");
    assert.equal(r.errors[0].message, "run 'clank-fake' found node_modules/.bin/clank-fake inside the project, and the agent can change files there. Write the path in the tool to run it on purpose: run './node_modules/.bin/clank-fake'");
    assert.deepEqual(await output("go_path\nprint it.output"), ["fake\n"]);
  });
});

test("a relative PATH entry counts as inside the project", { skip: process.platform === "win32" }, async () => {
  await fakeProgram(".");
  await agentsTalk("allow env PATH\ntool go\n  run 'clank-fake'\nend");
  await withPath(".", async () => {
    const r = await result("go");
    assert.match(r.errors[0].message, /^run 'clank-fake' found clank-fake inside the project/);
  });
});

test("a program found through PATH outside the project runs", { skip: process.platform === "win32" }, async () => {
  await agentsTalk("allow env PATH\ntool go\n  run 'node' with '-e', 'console.log(1)'\nend");
  await withPath(path.dirname(NODE), async () => {
    assert.deepEqual(await output("go\nprint it.output"), ["1\n"]);
  });
});

test("the option error names the file of the tool", async () => {
  await fs.mkdir(path.join(root, "talk"));
  await fs.writeFile(path.join(root, "talk", "echo.talk"), `tool echo with text\n  run '${NODE}' with '-e', '1', text\nend`);
  await agentsTalk("import ./talk/echo.talk");
  const r = await result("echo '-x'");
  assert.match(r.errors[0].message, /^The argument '-x' starts with '-', and it is not written out in talk\/echo\.talk\./);
});
