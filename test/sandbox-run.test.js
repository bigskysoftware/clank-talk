import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { run, stopAllProcesses } from "../src/js/clank-talk.js";
import { parse } from "../src/js/parser.js";

// the real sandbox tests cannot run inside a sandbox: a sandbox cannot start inside another
const onMac = process.platform === "darwin" && process.env.CLANK_TALK_SANDBOXED !== "1";
let root;
let server;
const processes = new Map();

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "clank-sbxrun-"));
  await fs.mkdir(path.join(root, ".git"));
  // inside a sandbox with no network, the server cannot open; the tests that need it skip there
  server = net.createServer((socket) => socket.end("hi"));
  let port = 0;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    port = server.address().port;
  } catch (err) {
    server = null;
  }
  const node = (code) => "run 'node' with '-e', \"" + code + "\"";
  await fs.writeFile(path.join(root, "AGENTS.talk"), [
    "allow env PATH",
    "tool write_ok",
    "  " + node("require('fs').writeFileSync('ok.txt', 'x')") + " in a sandbox",
    "end",
    "tool write_git",
    "  " + node("require('fs').writeFileSync('.git/x', 'x')") + " in a sandbox",
    "end",
    "tool read_home",
    "  " + node("console.log(require('fs').readdirSync('" + os.homedir() + "').length > 0)") + " in a sandbox",
    "end",
    "tool read_home_allowed",
    "  " + node("console.log(require('fs').readdirSync('" + os.homedir() + "').length > 0)") + " in a sandbox with reads of '~'",
    "end",
    "tool show_home",
    "  " + node("console.log(require('os').homedir() === '" + os.homedir() + "', require('fs').existsSync(require('os').homedir() + '/.gitconfig'))") + " in a sandbox",
    "end",
    "tool connect",
    "  " + node("require('net').connect(" + port + ", '127.0.0.1').on('data', (d) => console.log(String(d))).on('error', (e) => { console.log(e.code); process.exit(1) })") + " in a sandbox",
    "end",
    "tool connect_allowed",
    "  " + node("require('net').connect(" + port + ", '127.0.0.1').on('data', (d) => console.log(String(d))).on('error', (e) => { console.log(e.code); process.exit(1) })") + " in a sandbox with network",
    "end",
    "tool connect_local",
    "  " + node("require('net').connect(" + port + ", '127.0.0.1').on('data', (d) => console.log(String(d))).on('error', (e) => { console.log(e.code); process.exit(1) })") + " in a sandbox with local network",
    "end",
    "tool internet_local",
    "  " + node("require('net').connect(443, '1.1.1.1').on('connect', () => { console.log('connected'); process.exit(0) }).on('error', (e) => { console.log(e.code); process.exit(1) })") + " in a sandbox with local network",
    "end",
    "tool serve",
    "  start 'node' with '-e', \"console.log('up'); setInterval(() => {}, 1000)\" as 'srv' in a sandbox",
    "end",
    "tool plain",
    "  run 'node' with '-e', \"console.log(1)\"",
    "end",
  ].join("\n"));
});

after(async () => {
  stopAllProcesses(processes);
  if (server !== null) {
    server.close();
  }
  await fs.rm(root, { recursive: true, force: true });
});

async function call(source) {
  const result = await run(source, { root, processes });
  assert.deepEqual(result.errors, []);
  return result.output;
}

test("the sandbox clause parses on run and start", () => {
  assert.equal(parse("tool t\n  run 'x' in a sandbox with local network\nend", { definitions: true }).script.definitions[0].body[0].sandbox.localNetwork, true);
  const { script, errors } = parse("tool t\n  run 'npm' with 'test' in a sandbox with network, writes to '~/.m2', reads of '~/.x' within 5 minutes\n  start 'npm run dev' as 'site' in a sandbox\nend", { definitions: true });
  assert.deepEqual(errors, []);
  const [runNode, startNode] = script.definitions[0].body;
  assert.equal(runNode.sandbox.network, true);
  assert.equal(runNode.sandbox.writes.length, 1);
  assert.equal(runNode.sandbox.reads.length, 1);
  assert.equal(runNode.within.ms, 60000);
  assert.equal(startNode.sandbox.network, false);
  assert.match(parse("tool t\n  run 'x' in a box\nend", { definitions: true }).errors[0].message, /Expected 'sandbox'/);
});

test("in a sandbox: the project is writable, .git is not", { skip: !onMac }, async () => {
  assert.deepEqual(await call("write_ok\nprint the result's code"), ["0"]);
  assert.equal(await fs.readFile(path.join(root, "ok.txt"), "utf8"), "x");
  assert.notDeepEqual(await call("write_git\nprint the result's code"), ["0"]);
  await assert.rejects(fs.access(path.join(root, ".git", "x")));
});

test("in a sandbox: no home folder, unless 'reads of'", { skip: !onMac }, async () => {
  assert.notDeepEqual(await call("read_home\nprint the result's code"), ["0"]);
  assert.deepEqual(await call("read_home_allowed\nprint the result's output"), ["true\n"]);
});

test("in a sandbox: HOME is a fresh folder, with no config files in it", { skip: !onMac }, async () => {
  assert.deepEqual(await call("show_home\nprint the result's output"), ["false false\n"]);
});
test("in a sandbox: no network, unless 'with network'", { skip: !onMac }, async () => {
  assert.notDeepEqual(await call("connect\nprint the result's code"), ["0"]);
  assert.deepEqual(await call("connect_allowed\nprint the result's output"), ["hi\n"]);
});

test("in a sandbox with local network: localhost yes, the internet no", { skip: !onMac }, async () => {
  assert.deepEqual(await call("connect_local\nprint the result's output"), ["hi\n"]);
  assert.notDeepEqual(await call("internet_local\nprint the result's code"), ["0"]);
});
test("start in a sandbox", { skip: !onMac }, async () => {
  await call("serve");
  await call("wait until the output of process 'srv' contains 'up' within 5 seconds");
  assert.deepEqual(await call("print process 'srv'\nstop process 'srv'"), ["srv: running"]);
});

test("a hook can require the sandbox", async () => {
  const agents = await fs.readFile(path.join(root, "AGENTS.talk"), "utf8");
  await fs.writeFile(path.join(root, "AGENTS.talk"), agents + "\nbefore run\n  if the run's sandbox is null\n    reject 'Use a sandbox'\n  end\nend");
  try {
    const result = await run("plain", { root, processes });
    assert.deepEqual(result.errors.map((e) => e.message), ["Use a sandbox"]);
  } finally {
    await fs.writeFile(path.join(root, "AGENTS.talk"), agents);
  }
});
