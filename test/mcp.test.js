import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { handleMessage, toolsChanged } from "../src/js/harnesses/mcp.js";
import { staleCodeWarning, codeHashes, projectRoot, parentAgentsTalk, rootWarning, formatResult } from "../src/js/host.js";

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

test("the root comes from --root, then CLANK_TALK_ROOT, then the folder where the host starts", () => {
  assert.equal(projectRoot("/a/given", "/a/cwd", { CLANK_TALK_ROOT: "/a/env" }), "/a/given");
  assert.equal(projectRoot(null, "/a/cwd", { CLANK_TALK_ROOT: "/a/env" }), "/a/env");
  assert.equal(projectRoot(null, "/a/cwd", {}), "/a/cwd");
});

test("a root with no AGENTS.talk, under a folder that has one, gets a warning in each result and the description", async () => {
  await fs.writeFile(path.join(root, "AGENTS.talk"), "tool lint\nend");
  const sub = path.join(root, "src", "deep");
  await fs.mkdir(sub, { recursive: true });
  assert.equal(parentAgentsTalk(sub, root), root);
  assert.equal(parentAgentsTalk(root, root), null);
  const warning = rootWarning(sub, root);
  assert.match(warning.message, /^No AGENTS\.talk in .*src\/deep, but .* has one\. .*CLANK_TALK_ROOT=.*--root /);
  // the search stops at the home folder
  assert.equal(parentAgentsTalk(sub, sub), null);
  const text = formatResult({ output: ["1"], errors: [], warnings: [], changes: [], status: "done" }, "print 1", sub);
  assert.match(text, /--- warnings ---\nNo AGENTS\.talk in /);
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
  const response = await call("print 1\n\tprint 2 * 'x'");
  assert.equal(response.result.content[0].text, "1\n\n--- failed ---\n2:10 Expected a number, found 'x'\n  2 | \tprint 2 * 'x'\n    | \t        ^");
});

test("an untrusted tool makes the session untrusted, across scripts", async () => {
  await fs.writeFile(path.join(root, "AGENTS.talk"), "untrusted tool issue\n  set the result to 'from the web'\nend");
  assert.equal((await call("print the session is untrusted")).result.content[0].text, "false");
  await call("print issue");
  assert.equal((await call("print the session is untrusted")).result.content[0].text, "true");
  assert.equal((await call("print the session is untrusted")).result.content[0].text, "true");
  assert.equal((await call("print (the session's untrusted inputs)[0]'s source")).result.content[0].text, "tool issue");
});

test('long output is cut, and the next script can read all of it as the previous output', async () => {
  const response = await call("repeat 3000 times\n  print 'line'\nend");
  const text = response.result.content[0].text;
  assert.match(text, /\n\.\.\. 2000 lines cut\. All 3000 lines are in: the previous output\. To keep them for later: set \$log to the previous output\n/);
  assert.equal(text.split("\n").length, 1001);
  const next = await call("print length of lines of the previous output");
  assert.equal(next.result.content[0].text, "3000");
  // that script's output is now the previous output
  assert.equal((await call("print the previous output")).result.content[0].text, "3000");
});

test('limit output in AGENTS.talk makes the cut smaller, and never larger', async () => {
  await fs.writeFile(path.join(root, 'AGENTS.talk'), 'limit output keeping the first 5 and the last 5 lines');
  try {
    const text = (await call("repeat 30 times\n  print 'line'\nend")).result.content[0].text;
    assert.equal(text.split("\n").length, 11);
    assert.match(text, /\.\.\. 20 lines cut\. All 30 lines/);
    await fs.writeFile(path.join(root, 'AGENTS.talk'), 'limit output keeping the first 2500 and the last 2500 lines or 100 KB');
    assert.equal((await call("repeat 1500 times\n  print 'line'\nend")).result.content[0].text.split("\n").length, 1001);
    await fs.writeFile(path.join(root, 'AGENTS.talk'), 'limit output keeping the first 300 lines or 1 KB');
    assert.match((await call("repeat 300 times\n  print 'line'\nend")).result.content[0].text, /lines cut\. All 300 lines/);
  } finally {
    await fs.rm(path.join(root, 'AGENTS.talk'));
  }
});

test('one very long line is cut too', async () => {
  const long = await call("set t to 'ab'\nrepeat 16 times\n  set t to t + t\nend\nprint t");
  assert.match(long.result.content[0].text, /^(ab)+\n\.\.\. the rest is cut\. The full text is in: the previous output/);
});

test('warnings show before errors, with an arrow', async () => {
  const response = await call("set t to 'abc'\nreplace 'x' with 'y' in t");
  assert.equal(response.result.isError, false);
  assert.equal(response.result.content[0].text, "--- warnings ---\n2:1 No match in the variable for 'x'\n  2 | replace 'x' with 'y' in t\n    | ^");
});

test('an error in AGENTS.talk shows its line, with an arrow', async () => {
  await fs.writeFile(path.join(root, 'AGENTS.talk'), "tool bad\n  print 1\n  print 2 * 'x'\nend");
  const response = await call('bad');
  assert.equal(response.result.content[0].text, "1\n\n--- failed ---\nAGENTS.talk 3:11 Expected a number, found 'x'\n  3 |   print 2 * 'x'\n    |           ^");
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
  // titled choices, the first one chosen at the start
  const options = [{ const: 'yes', title: 'yes' }, { const: 'no', title: 'no' }];
  assert.deepEqual(asked, [{ message: 'Push?', requestedSchema: { type: 'object', properties: { answer: { type: 'string', title: 'Answer', oneOf: options, default: 'yes' } }, required: ['answer'] } }]);
});

test("ask: 'value: description' gives the value, and 'with any of' gives a list", async () => {
  await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: { elicitation: {} } } }, session);
  const asked = [];
  let content = null;
  session.send = (message) => {
    if (message.method === 'elicitation/create') {
      asked.push(message.params.requestedSchema);
      setImmediate(() => handleMessage({ jsonrpc: '2.0', id: message.id, result: { action: 'accept', content } }, session));
    }
  };
  content = { answer: 'production: the live site' };
  const one = await call("ask 'Deploy where?' with 'staging: the test site' or 'production: the live site'\nprint it");
  assert.equal(one.result.content[0].text, 'production');
  content = { answer: ['b.js: changed'] };
  const many = await call("ask 'Commit which?' with any of 'a.js: new' or 'b.js: changed'\nprint it as json");
  assert.equal(many.result.content[0].text, '["b.js"]');
  assert.deepEqual(asked[1].properties.answer, { type: 'array', title: 'Choices', items: { anyOf: [{ const: 'a.js: new', title: 'a.js: new' }, { const: 'b.js: changed', title: 'b.js: changed' }] } });
  assert.deepEqual(asked[1].required, []);
  // none picked is an empty list; a value that is not a choice is no answer
  content = { answer: [] };
  assert.equal((await call("ask 'Commit which?' with any of 'a.js' or 'b.js'\nprint it as json")).result.content[0].text, '[]');
  content = { answer: ['c.js'] };
  assert.equal((await call("ask 'Commit which?' with any of 'a.js' or 'b.js'\nprint it")).result.content[0].text, 'null');
  // only ': ' splits, so a URL stays whole
  content = { answer: 'http://x' };
  assert.equal((await call("ask 'Which?' with 'http://x' or 'http://y'\nprint it")).result.content[0].text, 'http://x');
});

test('ask in Claude Code: the clank-talk mod answers at a local URL with a one-time token', async () => {
  await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'claude-code' }, capabilities: { elicitation: {} } } }, session);
  const asked = [];
  const posts = [];
  let used = null;
  session.send = (message) => {
    if (message.method === 'elicitation/create') {
      const schema = message.params.requestedSchema;
      asked.push(schema);
      const clank = schema['x-clank'];
      if (clank === undefined) {
        setImmediate(() => handleMessage({ jsonrpc: '2.0', id: message.id, result: { action: 'accept', content: { answer: 'no' } } }, session));
        return;
      }
      // the mod: a wrong token is refused, the right one answers, then it declines the dialog
      used = clank;
      setImmediate(async () => {
        posts.push((await fetch(clank.url, { method: 'POST', body: JSON.stringify({ token: 'wrong', answer: 'yes' }) })).status);
        posts.push((await fetch(clank.url, { method: 'POST', body: JSON.stringify({ token: clank.token, answer: 'yes' }) })).status);
        await handleMessage({ jsonrpc: '2.0', id: message.id, result: { action: 'decline' } }, session);
      });
    }
  };
  const response = await call("ask 'Push?' with 'yes' or 'no'\nprint it");
  assert.equal(response.result.content[0].text, 'yes');
  // the token is used once
  const again = (await fetch(used.url, { method: 'POST', body: JSON.stringify({ token: used.token, answer: 'no' }) })).status;
  assert.equal(again, 403);
  assert.deepEqual(posts.slice(0, 1), [403]);
  assert.match(asked[0]['x-clank'].token, /^[0-9a-f]{32}$/);
  assert.match(asked[0]['x-clank'].url, /^http:\/\/127\.0\.0\.1:\d+\/answer$/);
  // more than 4 choices, or none, use the form alone
  await call("ask 'Pick?' with 'a' or 'b' or 'c' or 'd' or 'e'\nprint it");
  await call("ask 'Name?'\nprint it");
  assert.equal(asked[1]['x-clank'], undefined);
  assert.equal(asked[2]['x-clank'], undefined);
});

test('ask: a time limit cancels the question, so the client closes its dialog', async () => {
  await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: { elicitation: {} } } }, session);
  const sent = [];
  session.send = (message) => sent.push(message);
  const response = await call("ask 'Push?' with 'yes' or 'no' within 50 ms\nprint it");
  assert.equal(response.result.content[0].text, 'null');
  const asked = sent.find((message) => message.method === 'elicitation/create');
  const cancelled = sent.find((message) => message.method === 'notifications/cancelled');
  assert.equal(cancelled.params.requestId, asked.id);
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
  const [file] = await fs.readdir(path.join(root, '.talk', 'audit'));
  const text = await fs.readFile(path.join(root, '.talk', 'audit', file), 'utf8');
  assert.match(text, /script 1 \(writer\)  \(done, /);
  assert.match(text, /script 2 \(tester\)  \(done, /);
});

test('a bad agent name is an error', async () => {
  const response = await callAs('no spaces please', 'print 1');
  assert.match(response.error.message, /^The argument 'agent' must be a name/);
});

test("the MCP server names the session after the client, for the audit", async () => {
  await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'Claude Code' } } }, session);
  assert.match(session.name, /^claude-code-[0-9a-f]{4}$/);
});

test("a warning when the code changed after the server started", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clank-stale-"));
  try {
    await fs.mkdir(path.join(dir, "harnesses"));
    await fs.writeFile(path.join(dir, "harnesses", "mcp.js"), "// code");
    await fs.writeFile(path.join(dir, "notes.txt"), "not code");
    const baseline = codeHashes(dir);
    assert.equal(staleCodeWarning(dir, Date.now() + 60_000, baseline), null);
    // a newer change time with the same text, as after git switch: no warning
    await fs.writeFile(path.join(dir, "harnesses", "mcp.js"), "// code");
    assert.equal(staleCodeWarning(dir, 0, baseline), null);
    // new text: a warning
    await fs.writeFile(path.join(dir, "harnesses", "mcp.js"), "// new code");
    const warning = staleCodeWarning(dir, 0, baseline);
    assert.match(warning.message, /^The ClankTalk server is older than its code \(harnesses\/mcp\.js changed at \d\d:\d\d\)\. Ask the human to reconnect it/);
    assert.equal(warning.line, undefined);
    // a new .js file is new code too
    await fs.writeFile(path.join(dir, "harnesses", "mcp.js"), "// code");
    await fs.writeFile(path.join(dir, "extra.js"), "// extra");
    assert.match(staleCodeWarning(dir, 0, baseline).message, /extra\.js changed/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});