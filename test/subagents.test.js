import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { run } from "../src/js/clank-talk.js";
import { lendModelFor } from "../src/js/harnesses/pi-host.js";

// see src/md/features/subagents.md
// a fake Messages API: each test sets the replies; the server records each request

let server;
let url;
let replies;
let requests;
let root;

const AGENTS = [
  "allow secret ANTHROPIC_API_KEY for subagents",
  "use model 'claude-sonnet-5-5' for subagents with secret ANTHROPIC_API_KEY",
  "",
  "# Lists the open issues that match a query.",
  "untrusted tool gh_issues with query",
  "  set the result to 'issue #1: crash when ' + query",
  "end",
  "",
  "tool broken",
  "  set x to 1 / 0",
  "end",
  "",
  "tool summarize",
  "  run 'Summarize the most important open issues' in a subagent with only gh_issues, broken",
  "end",
].join("\n");

before(async () => {
  server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({ headers: request.headers, body: JSON.parse(body) });
      const reply = replies.length > 1 ? replies.shift() : replies[0];
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(reply));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = "http://127.0.0.1:" + server.address().port + "/v1/messages";
  root = await fs.mkdtemp(path.join(os.tmpdir(), "clank-subagents-"));
  await fs.writeFile(path.join(root, ".env"), "ANTHROPIC_API_KEY=sk-test-12345678\n");
  await fs.writeFile(path.join(root, "AGENTS.talk"), AGENTS);
});

after(async () => {
  server.close();
  await fs.rm(root, { recursive: true, force: true });
});

function toolUse(id, name, input) {
  return { stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }] };
}

function answer(text) {
  return { stop_reason: "end_turn", content: [{ type: "text", text }] };
}

async function go(script, options = {}) {
  requests = [];
  return await run(script, { root, subagentUrl: url, ...options });
}

test("a subagent calls its tools, and its answer is untrusted", async () => {
  replies = [toolUse("toolu_1", "gh_issues", { query: "bug" }), answer("Top issue: #1")];
  const audit = { scripts: 0, records: [] };
  const result = await go("summarize\nprint it\nprint it is untrusted", { audit });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.output, ["Top issue: #1", "true"]);
  // the request: headers, model, tools with their # comment, and the tool result on the second turn
  const [first, second] = requests;
  assert.equal(first.headers["x-api-key"], "sk-test-12345678");
  assert.equal(first.headers["anthropic-version"], "2026-10-21");
  assert.equal(first.body.model, "claude-sonnet-5-5");
  assert.equal(first.body.messages[0].content, "Summarize the most important open issues");
  assert.deepEqual(first.body.tools[0], { name: "gh_issues", description: "Lists the open issues that match a query.", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } });
  assert.equal(first.body.tool_choice, undefined);
  assert.deepEqual(second.body.messages[2], { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "issue #1: crash when bug" }] });
  // the audit: the tool call is from the subagent, and the subagent step counts the calls
  const tool = audit.records.find((record) => record.kind === "tool" && record.target === "gh_issues");
  assert.equal(tool.from, "subagent summarize");
  const step = audit.records.find((record) => record.kind === "subagent");
  assert.equal(step.target, "subagent summarize");
  assert.match(step.details, /^1 tool call/);
});

test("a failed tool call goes back to the model as an error", async () => {
  replies = [toolUse("toolu_1", "broken", {}), toolUse("toolu_2", "nope", {}), answer("done")];
  const result = await go("summarize\nprint it");
  assert.deepEqual(result.output, ["done"]);
  assert.deepEqual(requests[1].body.messages[2].content[0], { type: "tool_result", tool_use_id: "toolu_1", content: "Division by zero", is_error: true });
  assert.match(requests[2].body.messages[4].content[0].content, /^There is no tool named nope/);
});

test("refusals, too many calls, and API errors fail the run", async () => {
  replies = [{ stop_reason: "refusal", stop_details: { category: "cyber" }, content: [] }];
  assert.deepEqual((await go("summarize")).errors.map((e) => e.message), ["The model refused the task: cyber"]);
  replies = [toolUse("toolu_x", "gh_issues", { query: "again" })];
  assert.deepEqual((await go("summarize")).errors.map((e) => e.message), ["The subagent made more than 20 tool calls"]);
  replies = [{ error: { type: "authentication_error", message: "invalid x-api-key" } }];
  const bad = http.createServer((request, response) => {
    response.statusCode = 401;
    response.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
  });
  await new Promise((resolve) => bad.listen(0, "127.0.0.1", resolve));
  try {
    const result = await run("summarize", { root, subagentUrl: "http://127.0.0.1:" + bad.address().port + "/v1/messages" });
    assert.deepEqual(result.errors.map((e) => e.message), ["The model API answered 401: invalid x-api-key"]);
  } finally {
    bad.close();
  }
});

test("a harness that cannot lend a model needs a key", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clank-subagents-"));
  try {
    await fs.writeFile(path.join(dir, "AGENTS.talk"), "tool t with q\n  set the result to q\nend\n\ntool s\n  run 'x' in a subagent with only t\nend");
    assert.deepEqual((await run("s", { root: dir, harness: "MCP" })).errors.map((e) => e.message), ["This harness (MCP) cannot lend its model to a subagent. Add a model and a key to AGENTS.talk: use model 'claude-sonnet-5-5' for subagents with secret ANTHROPIC_API_KEY"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a harness that lends its model needs no key", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clank-subagents-"));
  try {
    await fs.writeFile(path.join(dir, "AGENTS.talk"), "tool t with q\n  set the result to 'got ' + q\nend\n\ntool s\n  run 'x' in a subagent with only t\nend");
    const asked = [];
    const lendModel = (name) => async ({ history }) => {
      asked.push(name);
      if (history.length === 1) {
        return { stop: "tool_use", text: "", calls: [{ id: "1", name: "t", input: { q: "hi" } }], raw: "turn 1" };
      }
      return { stop: "end", text: "the tool said: " + history[2].results[0].content, calls: [], raw: "turn 2" };
    };
    const result = await run("s\nprint it", { root: dir, lendModel });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.output, ["the tool said: got hi"]);
    assert.deepEqual(asked, [null, null]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("load errors: unknown tools, unsafe tools, and a key not allowed for subagents", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clank-subagents-"));
  const loadErrors = async (agents) => {
    await fs.writeFile(path.join(dir, "AGENTS.talk"), agents);
    return (await run("print 1", { root: dir })).errors.map((e) => e.message);
  };
  try {
    assert.deepEqual(await loadErrors("tool s\n  run 'x' in a subagent with only nope\nend"), ["A subagent can use only tools from AGENTS.talk, and there is no tool nope"]);
    assert.deepEqual(await loadErrors("tool w with t\n  write t to ./out.txt\nend\n\ntool s\n  run 'x' in a subagent with only w\nend"), ["The tool w cannot be in a subagent's 'with only' list, because it uses 'write'. Injected text could choose its arguments"]);
    assert.deepEqual(await loadErrors("tool r with t\n  replace 'a' with t in ./a.txt\nend\n\ntool s\n  run 'x' in a subagent with only r\nend"), ["The tool r cannot be in a subagent's 'with only' list, because it uses 'replace' in a file. Injected text could choose its arguments"]);
    assert.deepEqual(await loadErrors("tool inner\n  run 'x' in a subagent with only inner\nend\n\ntool s\n  run 'y' in a subagent with only inner\nend"), [
      "The tool inner cannot be in a subagent's 'with only' list, because it uses another subagent. Injected text could choose its arguments",
      "The tool inner cannot be in a subagent's 'with only' list, because it uses another subagent. Injected text could choose its arguments",
    ]);
    assert.deepEqual(await loadErrors("use model 'claude-sonnet-5-5' for subagents with secret KEY_X"), ["'use model' needs its key allowed for subagents. Add: allow secret KEY_X for subagents"]);
    assert.deepEqual(await loadErrors("tool t\n  run 'x' with 'a' in a subagent with only t\nend"), ["A subagent takes a prompt only, with no 'with' arguments or 'using secret'"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a policy can deny subagents", async () => {
  const result = await run("print 1", { root, policy: { name: "p.talk", source: "policy 'p'\ndeny subagents" } });
  assert.match(result.errors[0].message, /denies subagents$/);
});

test("pi lends its own model through ctx.modelRegistry.complete", async () => {
  const calls = [];
  const ctx = {
    model: { id: "current" },
    modelRegistry: {
      find: (provider, id) => (provider === "anthropic" ? { id } : undefined),
      getAvailable: () => [{ id: "bare-model" }],
      complete: async (model, context) => {
        calls.push({ model, context });
        if (context.messages.length === 1) {
          return { stopReason: "toolUse", content: [{ type: "toolCall", id: "c1", name: "t", arguments: { q: "x" } }] };
        }
        return { stopReason: "stop", content: [{ type: "text", text: "ok" }] };
      },
    },
  };
  const lend = lendModelFor(ctx);
  assert.throws(() => lend("unknown/model"), /pi does not know the model unknown\/model/);
  assert.deepEqual(lend("anthropic/claude-sonnet-5-5") !== null, true);
  const ask = lend(null);
  const tools = [{ name: "t", description: "A tool.", params: ["q"] }];
  const first = await ask({ system: "sys", tools, history: [{ role: "user", text: "go" }], signal: AbortSignal.timeout(1000) });
  assert.deepEqual(first.calls, [{ id: "c1", name: "t", input: { q: "x" } }]);
  assert.equal(first.stop, "tool_use");
  const second = await ask({ system: "sys", tools, history: [{ role: "user", text: "go" }, { role: "assistant", raw: first.raw }, { role: "tool", results: [{ id: "c1", name: "t", content: "done", isError: false }] }], signal: AbortSignal.timeout(1000) });
  assert.equal(second.text, "ok");
  assert.equal(calls[0].model.id, "current");
  assert.equal(calls[0].context.systemPrompt, "sys");
  assert.deepEqual(calls[0].context.tools[0].parameters, { type: "object", properties: { q: { type: "string" } }, required: ["q"] });
  assert.equal(calls[1].context.messages[2].role, "toolResult");
  assert.equal(calls[1].context.messages[2].toolCallId, "c1");
});

test("start in a subagent runs in the background, as a process", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clank-subagents-"));
  const processes = new Map();
  try {
    await fs.writeFile(path.join(dir, "AGENTS.talk"), "tool t with q\n  set the result to 'got ' + q\nend\n\ntool watch\n  start 'Look into it' in a subagent with only t as 'looker'\nend");
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const lendModel = () => async ({ history }) => {
      if (history.length === 1) {
        await gate;
        return { stop: "tool_use", text: "", calls: [{ id: "1", name: "t", input: { q: "a; rm -rf /" } }], raw: "1" };
      }
      return { stop: "end", text: "found: " + history[2].results[0].content, calls: [], raw: "2" };
    };
    const started = await run("watch\nprint process 'looker'", { root: dir, lendModel, processes });
    assert.deepEqual(started.errors, []);
    assert.deepEqual(started.output, ["looker: running"]);
    release();
    const done = await run("wait until (process 'looker')'s status is 'exited' within 5 seconds\nprint (process 'looker')'s output\nprint (process 'looker')'s output is untrusted", { root: dir, lendModel, processes });
    assert.deepEqual(done.errors, []);
    // the argument went in a $ global, so it ran as text, not as script
    assert.deepEqual(done.output, ["found: got a; rm -rf /", "true"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("stop process stops a background subagent", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clank-subagents-"));
  const processes = new Map();
  try {
    await fs.writeFile(path.join(dir, "AGENTS.talk"), "tool t with q\n  set the result to q\nend\n\ntool watch\n  start 'x' in a subagent with only t as 'slow'\nend");
    const lendModel = () => async ({ signal }) => await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("stopped"))));
    assert.deepEqual((await run("watch\nstop process 'slow'\nprint process 'slow'", { root: dir, lendModel, processes })).output, ["slow: stopped"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
