import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { handleMessage, toolsChanged } from "../src/js/mcp.js";

let root;
let session;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "clank-mcp-"));
  session = { root, globals: Object.create(null) };
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function call(script, id = 1) {
  return handleMessage({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "clank_talk", arguments: { script } } }, session);
}

test("initialize answers with the client's protocol version", async () => {
  const response = await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, session);
  assert.equal(response.result.protocolVersion, "2025-06-18");
  assert.deepEqual(response.result.capabilities, { tools: { listChanged: true } });
  assert.equal(response.result.serverInfo.name, "clank-talk");
});

test("notifications get no answer", async () => {
  assert.equal(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, session), null);
});

test("tools/list has one tool, with the AGENTS.talk tools in its description", async () => {
  await fs.writeFile(path.join(root, "AGENTS.talk"), "tool run_test with name\nend\ntool lint\nend");
  const response = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, session);
  const [tool] = response.result.tools;
  assert.equal(tool.name, "clank_talk");
  assert.deepEqual(tool.inputSchema.required, ["script"]);
  assert.match(tool.description, /run_test with name/);
  assert.match(tool.description, /\n {2}lint/);
});

test("tools/call runs the script", async () => {
  const response = await call("print 1 + 1");
  assert.deepEqual(response.result, { content: [{ type: "text", text: "2" }], isError: false });
});

test("errors are listed, and set isError", async () => {
  const response = await call("print 1\nprint 1 / 0");
  assert.equal(response.result.isError, true);
  assert.equal(response.result.content[0].text, "1\n\n--- failed ---\n2:9 Division by zero\n  2 | print 1 / 0\n    |         ^");
});

test("changed files are listed", async () => {
  const response = await call("write 'x' to ./a.txt");
  assert.equal(response.result.content[0].text, "--- changed files ---\na.txt  (new file, 1 line)");
});

test("no output", async () => {
  const response = await call("set x to 1");
  assert.equal(response.result.content[0].text, "(no output)");
});

test("globals stay between calls", async () => {
  await call("set $n to 41");
  const response = await call("print $n + 1");
  assert.equal(response.result.content[0].text, "42");
});

test("unknown methods and tools are errors", async () => {
  const method = await handleMessage({ jsonrpc: "2.0", id: 3, method: "nope" }, session);
  assert.equal(method.error.code, -32601);
  const tool = await handleMessage({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "bash", arguments: {} } }, session);
  assert.equal(tool.error.code, -32602);
});

test("the server speaks JSON-RPC over stdio", async () => {
  const child = spawn(process.execPath, ["bin/clank-talk-mcp.js", "--root", root]);
  const lines = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      lines.push(JSON.parse(buffer.slice(0, buffer.indexOf("\n"))));
      buffer = buffer.slice(buffer.indexOf("\n") + 1);
    }
  });
  const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "clank_talk", arguments: { script: "print 'hello'" } } });
  // U+2028 and U+2029 are allowed in a JSON string, so they do not end a line
  const separators = String.fromCharCode(0x2028) + String.fromCharCode(0x2029);
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "clank_talk", arguments: { script: "print 'a" + separators + "b'" } } });
  while (lines.length < 3) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  child.kill();
  // calls run at the same time, so the answers can come in any order
  const text = (id) => lines.find((line) => line.id === id).result.content[0].text;
  assert.equal(lines[0].id, 1);
  assert.equal(text(2), "hello");
  assert.equal(text(3), "a" + separators + "b");
});

test('progress notifications go out on a timer, also while a tool runs', async () => {
  await fs.writeFile(path.join(root, 'AGENTS.talk'), "allow env PATH\ntool slow\n  run 'node' with '-e', 'setTimeout(() => {}, 300)'\nend");
  const sent = [];
  session.send = (message) => sent.push(message);
  session.progressEveryMs = 20;
  await handleMessage({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'clank_talk', arguments: { script: 'print 1\nslow' }, _meta: { progressToken: 'abc' } } }, session);
  assert.ok(sent.length >= 2, 'sent ' + sent.length);
  assert.equal(sent[0].method, 'notifications/progress');
  assert.equal(sent[0].params.progressToken, 'abc');
  assert.equal(sent[0].params.total, undefined);
  assert.equal(sent[1].params.progress, sent[0].params.progress + 1);
  assert.match(sent[sent.length - 1].params.message, /^line 3: run \(step 3, \d+\.\ds\)$/);
});

test('no progress without a token', async () => {
  const sent = [];
  session.send = (message) => sent.push(message);
  await call('print 1');
  assert.deepEqual(sent, []);
});

test('an error shows the script line, with an arrow at the column', async () => {
  const response = await call('print 1\n\tprint 2 * x');
  assert.equal(response.result.content[0].text, '1\n\n--- failed ---\n2:10 Expected a number, found null\n  2 | \tprint 2 * x\n    | \t        ^');
});

test('warnings show before errors, with an arrow', async () => {
  const response = await call("set t to 'abc'\nreplace 'x' with 'y' in t");
  assert.equal(response.result.isError, false);
  assert.equal(response.result.content[0].text, "--- warnings ---\n2:1 No match in the variable for 'x'\n  2 | replace 'x' with 'y' in t\n    | ^");
});

test('an error in AGENTS.talk shows its line, with an arrow', async () => {
  await fs.writeFile(path.join(root, 'AGENTS.talk'), "tool bad\n  print 1\n  print 2 * x\nend");
  const response = await call('bad');
  assert.equal(response.result.content[0].text, '1\n\n--- failed ---\nAGENTS.talk 3:11 Expected a number, found null\n  3 |   print 2 * x\n    |           ^');
});

test('ask goes to the human as an MCP elicitation', async () => {
  await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { elicitation: {} } } }, session);
  const asked = [];
  session.send = (message) => {
    if (message.method === 'elicitation/create') {
      asked.push(message.params);
      setImmediate(() => handleMessage({ jsonrpc: '2.0', id: message.id, result: { action: 'accept', content: { answer: 'yes' } } }, session));
    }
  };
  const response = await call("ask 'Push?' with 'yes' or 'no'\nprint it");
  assert.equal(response.result.content[0].text, 'yes');
  assert.deepEqual(asked, [{ message: 'Push?', requestedSchema: { type: 'object', properties: { answer: { type: 'string', title: 'Answer', enum: ['yes', 'no'] } }, required: ['answer'] } }]);
});

test('ask: decline is null, and a client with no elicitation is never asked', async () => {
  await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: { elicitation: {} } } }, session);
  session.send = (message) => {
    if (message.method === 'elicitation/create') {
      setImmediate(() => handleMessage({ jsonrpc: '2.0', id: message.id, result: { action: 'decline' } }, session));
    }
  };
  assert.equal((await call("ask 'Name?'\nprint it")).result.content[0].text, 'null');

  await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } }, session);
  const sent = [];
  session.send = (message) => sent.push(message);
  assert.equal((await call("ask 'Name?'\nprint it")).result.content[0].text, 'null');
  assert.deepEqual(sent, []);
});

test('a change to AGENTS.talk sends tools/list_changed, once', async () => {
  const sent = [];
  session.send = (message) => sent.push(message);
  // before the client lists the tools, there is nothing to tell
  assert.equal(await toolsChanged(session), false);
  await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, session);
  assert.equal(await toolsChanged(session), false);
  await fs.writeFile(path.join(root, 'AGENTS.talk'), '# Lints the code.\ntool lint\nend');
  assert.equal(await toolsChanged(session), true);
  assert.deepEqual(sent, [{ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }]);
  assert.equal(await toolsChanged(session), false);
});

function callAs(agent, script) {
  return handleMessage({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'clank_talk', arguments: { script, agent } } }, session);
}

test('each agent name has its own undo list and $ globals', async () => {
  session.audit = { scripts: 0, records: [] };
  await callAs('writer', "write 'A' to ./a.txt\nset $mine to 'writer'");
  await callAs('tester', "write 'B' to ./b.txt");
  // the tester's undo takes back only the tester's script
  await callAs('tester', 'undo');
  await assert.rejects(fs.access(path.join(root, 'b.txt')));
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'A');
  assert.equal((await callAs('tester', 'print $mine')).result.content[0].text, 'null');
  assert.equal((await callAs('writer', 'print $mine')).result.content[0].text, 'writer');
  // with no name, the session's own state
  assert.match((await call('undo')).result.content[0].text, /Nothing to undo/);
  // the audit names the agent
  const [file] = await fs.readdir(path.join(root, 'talk', 'audit'));
  const text = await fs.readFile(path.join(root, 'talk', 'audit', file), 'utf8');
  assert.match(text, /script 1 \(agent writer\)  done/);
  assert.match(text, /script 2 \(agent tester\)  done/);
});

test('a bad agent name is an error', async () => {
  const response = await callAs('no spaces please', 'print 1');
  assert.match(response.error.message, /^The argument 'agent' must be a name/);
});
