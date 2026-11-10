import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { run, start } from "../src/js/clank-talk.js";
import { handleMessage } from "../src/js/harnesses/mcp.js";

const MCP_BIN = "bin/clank-talk-mcp.js";

// edge cases for git, ask, wait, the MCP host, subagents and help
// each test makes its own temp folders; all go at the end

const made = [];

after(async () => {
  for (const dir of made) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

function gitIn(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { PATH: process.env.PATH, HOME: cwd } });
}

// a repo with one commit of a.txt
async function repo() {
  const root = await tempDir("clank-edge-");
  gitIn(root, ["init", "-q", "-b", "main"]);
  gitIn(root, ["config", "user.email", "t@t"]);
  gitIn(root, ["config", "user.name", "t"]);
  await fs.writeFile(path.join(root, "a.txt"), "a\n");
  gitIn(root, ["add", "a.txt"]);
  gitIn(root, ["commit", "-q", "-m", "first"]);
  return root;
}

async function errorsIn(root, source, options = {}) {
  const result = await run(source, { root, ...options });
  return result.errors.map((e) => e.message);
}

async function outputIn(root, source, options = {}) {
  const result = await run(source, { root, ...options });
  assert.deepEqual(result.errors, []);
  return result.output;
}

// ----- git: programs and secrets -----

test("git push to a remote folder inside the project is refused, because it runs that repo's hooks", async () => {
  const root = await repo();
  const inside = path.join(root, "mirror.git");
  gitIn(root, ["init", "-q", "--bare", inside]);
  const marker = path.join(root, "hook-ran");
  await fs.writeFile(path.join(inside, "hooks", "pre-receive"), "#!/bin/sh\ntouch '" + marker + "'\n", { mode: 0o755 });
  gitIn(root, ["remote", "add", "origin", "./mirror.git"]);
  assert.match((await errorsIn(root, "git push"))[0], /^git push cannot go to a remote inside the project/);
  await assert.rejects(fs.access(marker), "the hook ran");
  // a folder outside the project is the human's, so the push goes
  const outside = await tempDir("clank-edge-bare-");
  gitIn(outside, ["init", "-q", "--bare"]);
  gitIn(root, ["remote", "set-url", "origin", outside]);
  assert.deepEqual(await errorsIn(root, "git push"), []);
  assert.equal(gitIn(outside, ["log", "--oneline", "main"]).trim().split("\n").length, 1);
});

test("git show of a .env file's blob id does not show the secret", async () => {
  const root = await repo();
  await fs.writeFile(path.join(root, ".env.example"), "KEY=blob-secret\n");
  gitIn(root, ["add", "-f", ".env.example"]);
  gitIn(root, ["commit", "-q", "-m", "env"]);
  const blob = gitIn(root, ["rev-parse", "HEAD:.env.example"]).trim();
  const result = await run("git show '" + blob + "'\nprint it", { root });
  assert.doesNotMatch(result.output.join("\n"), /blob-secret/);
});

test("git show hides a .env file in a folder with a non-ASCII name", async () => {
  const root = await repo();
  await fs.mkdir(path.join(root, "données"));
  await fs.writeFile(path.join(root, "données", ".env"), "KEY=quoted-secret\n");
  gitIn(root, ["add", "-f", "données/.env"]);
  gitIn(root, ["commit", "-q", "-m", "env"]);
  const [shown] = await outputIn(root, "git show 'HEAD'\nprint it");
  assert.doesNotMatch(shown, /quoted-secret/);
  await fs.writeFile(path.join(root, "données", ".env"), "KEY=quoted-secret-2\n");
  const [diff] = await outputIn(root, "git diff\nprint it");
  assert.doesNotMatch(diff, /quoted-secret-2/);
});

test("git show hides a .env file in a merge commit (diff --cc)", async () => {
  const root = await repo();
  await fs.writeFile(path.join(root, ".env.example"), "KEY=base\n");
  gitIn(root, ["add", "-f", ".env.example"]);
  gitIn(root, ["commit", "-q", "-m", "env"]);
  gitIn(root, ["switch", "-q", "-c", "side"]);
  await fs.writeFile(path.join(root, ".env.example"), "KEY=side\n");
  gitIn(root, ["commit", "-q", "-a", "-m", "side"]);
  gitIn(root, ["switch", "-q", "main"]);
  await fs.writeFile(path.join(root, ".env.example"), "KEY=main\n");
  gitIn(root, ["commit", "-q", "-a", "-m", "main"]);
  try {
    execFileSync("git", ["merge", "-q", "side"], { cwd: root, stdio: "ignore", env: { PATH: process.env.PATH, HOME: root } });
  } catch (err) {
    // a conflict, as planned
  }
  await fs.writeFile(path.join(root, ".env.example"), "KEY=cc-secret\n");
  gitIn(root, ["commit", "-q", "-a", "-m", "merge"]);
  const [shown] = await outputIn(root, "git show 'HEAD'\nprint it");
  assert.doesNotMatch(shown, /cc-secret|KEY=side|KEY=main/);
});

test("a commit message with a NUL character is a script error, not a crash", async () => {
  const root = await repo();
  await fs.writeFile(path.join(root, "a.txt"), "changed\n");
  const result = await run("set m to '\"a\\\\u0000b\"' as json\ngit commit ./a.txt with m", { root });
  assert.equal(result.status, "failed");
});

test("git commit refuses .talk files and @/talk/, as git.md says", async () => {
  const root = await repo();
  await fs.writeFile(path.join(root, "AGENTS.talk"), "tool t\nend\n");
  await fs.mkdir(path.join(root, "talk"));
  await fs.writeFile(path.join(root, "talk", "x.txt"), "x\n");
  assert.equal((await errorsIn(root, "git commit ./AGENTS.talk with 'tools'")).length, 1);
  assert.equal((await errorsIn(root, "git commit ./talk/x.txt with 'talk'")).length, 1);
  assert.equal(gitIn(root, ["log", "--oneline"]).trim().split("\n").length, 1);
});

test("with the root in a subfolder of a repo, git output covers only the root's files", async () => {
  const outer = await repo();
  await fs.mkdir(path.join(outer, "sub"));
  await fs.writeFile(path.join(outer, "sub", "in.txt"), "in\n");
  gitIn(outer, ["add", "sub/in.txt"]);
  gitIn(outer, ["commit", "-q", "-m", "sub"]);
  await fs.writeFile(path.join(outer, "a.txt"), "outside-text\n");
  await fs.writeFile(path.join(outer, "sub", "in.txt"), "inside-text\n");
  const root = path.join(outer, "sub");
  const [status, diff, log] = await outputIn(root, "git status\nprint it\ngit diff\nprint it\ngit log\nprint it");
  assert.doesNotMatch(status, /a\.txt/);
  assert.match(status, /in\.txt/);
  assert.doesNotMatch(diff, /outside-text/);
  assert.match(diff, /inside-text/);
  // the first commit changed only a.txt, outside the root
  assert.doesNotMatch(log, /first/);
  assert.match(log, /sub/);
});

// ----- git: values from the script -----

test("a commit message that starts with - and has lines is the message, not an option", async () => {
  const root = await repo();
  await fs.writeFile(path.join(root, "a.txt"), "b\n");
  await outputIn(root, "git commit ./a.txt with '--amend\\n--author=x <x@x>'");
  assert.equal(gitIn(root, ["log", "-1", "--format=%B"]), "--amend\n--author=x <x@x>\n\n");
  assert.equal(gitIn(root, ["log", "--oneline"]).trim().split("\n").length, 2);
  assert.equal(gitIn(root, ["log", "-1", "--format=%an"]), "t\n");
});

test("odd branch names are refused before git runs, or give git's error", async () => {
  const root = await repo();
  for (const name of ["fïx", "a b", "a@{1}", "-b", "a..b", "a~1", "a^", "a:b", "a\\\\b"]) {
    const [message] = await errorsIn(root, "git switch to new branch '" + name + "'");
    assert.match(message, /^Not a safe branch name/, name);
  }
  // names that pass the check but git refuses: git's error, never a crash
  for (const name of ["a/.b", "a.lock/b", "HEAD"]) {
    const [message] = await errorsIn(root, "git switch to new branch '" + name + "'");
    assert.match(message, /^git switch failed: /, name);
  }
  assert.equal(gitIn(root, ["branch", "--list"]), "* main\n");
});

// ----- ask -----

test("ask within 0 seconds, or a negative time, gives null at once", async () => {
  const never = () => new Promise(() => {});
  const started = Date.now();
  assert.deepEqual(await outputIn(undefined, "ask 'Push?' with 'yes' or 'no' within 0 seconds\nprint it", { ask: never }), ["null"]);
  assert.deepEqual(await outputIn(undefined, "ask 'Push?' within -1 seconds\nprint it", { ask: never }), ["null"]);
  assert.ok(Date.now() - started < 1000);
});

// ----- wait -----

test("wait for more than 24.8 days still waits", async () => {
  const execution = start("wait 600 hours\nprint 'after'", {});
  const timer = setTimeout(() => execution.cancel(), 300);
  const result = await execution.done;
  clearTimeout(timer);
  assert.deepEqual(result.output, []);
  assert.equal(result.status, "cancelled");
});

test("wait until that never comes true stops at its time limit", async () => {
  const started = Date.now();
  const result = await run("wait until 1 is 2 within 300ms", {});
  assert.deepEqual(result.errors.map((e) => e.message), ["wait until did not come true within 300ms"]);
  assert.ok(Date.now() - started < 2000);
  // within 0: one check, then the error
  assert.deepEqual((await run("wait until false within 0 seconds", {})).errors.map((e) => e.message), ["wait until did not come true within 0ms"]);
});

test("cancel stops a wait at once", async () => {
  const execution = start("wait 10 seconds\nprint 'after'", {});
  setTimeout(() => execution.cancel(), 50);
  const started = Date.now();
  const result = await execution.done;
  assert.equal(result.status, "cancelled");
  assert.ok(Date.now() - started < 2000);
});

// ----- the MCP host -----

function mcpSession(root) {
  return { root, globals: Object.create(null) };
}

function mcpCall(session, args, id = 1) {
  return handleMessage({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "clank_talk", arguments: args } }, session);
}

test("MCP: a missing script, or one that is not text, is an invalid params error", async () => {
  const session = mcpSession(await tempDir("clank-edge-mcp-"));
  for (const args of [null, {}, { script: 5 }, { script: ["print 1"] }]) {
    const response = await mcpCall(session, args);
    assert.equal(response.error.code, -32602, JSON.stringify(args));
  }
  const noParams = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/call" }, session);
  assert.equal(noParams.error.code, -32602);
});

test("MCP: agent names such as __proto__ and constructor have their own scope", async () => {
  const session = mcpSession(await tempDir("clank-edge-mcp-"));
  for (const agent of ["__proto__", "constructor", "toString", "..", "."]) {
    await mcpCall(session, { script: "set $who to '" + agent + "'", agent });
  }
  for (const agent of ["__proto__", "constructor", "toString", "..", "."]) {
    assert.equal((await mcpCall(session, { script: "print $who", agent })).result.content[0].text, agent);
  }
  assert.equal((await mcpCall(session, { script: "print $who" })).result.content[0].text, "null");
  assert.equal({}.who, undefined);
  assert.equal(Object.prototype.who, undefined);
});

test("MCP: two calls at once with the same agent each go on its undo list", async () => {
  const root = await tempDir("clank-edge-mcp-");
  const session = mcpSession(root);
  await Promise.all([
    mcpCall(session, { script: "wait 50ms\nwrite 'A' to ./a.txt", agent: "w" }, 1),
    mcpCall(session, { script: "write 'B' to ./b.txt", agent: "w" }, 2),
  ]);
  await mcpCall(session, { script: "undo", agent: "w" });
  await mcpCall(session, { script: "undo", agent: "w" });
  await assert.rejects(fs.access(path.join(root, "a.txt")));
  await assert.rejects(fs.access(path.join(root, "b.txt")));
});

test("MCP server: a JSON line that is null does not stop the server", async () => {
  const root = await tempDir("clank-edge-mcp-");
  const child = spawn(process.execPath, [MCP_BIN, "--root", root]);
  const lines = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      lines.push(JSON.parse(buffer.slice(0, buffer.indexOf("\n"))));
      buffer = buffer.slice(buffer.indexOf("\n") + 1);
    }
  });
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  child.stdin.write("null\n");
  // the crash comes a tick later, so the ping goes after it
  await new Promise((resolve) => setTimeout(resolve, 300));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }) + "\n");
  const deadline = Date.now() + 3000;
  while (!lines.some((line) => line.id === 2) && !exited && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  child.kill();
  assert.ok(lines.some((line) => line.id === 2), "no answer to the ping; the server exited: " + exited);
});

// ----- subagents -----

const SUBAGENT_AGENTS = [
  "allow secret ANTHROPIC_API_KEY for subagents",
  "use model 'claude-sonnet-5-5' for subagents with secret ANTHROPIC_API_KEY",
  "tool echo with text",
  "  set the result to 'echo: ' + text",
  "end",
  "tool ask_sub",
  "  run 'Do it' in a subagent with only echo",
  "end",
].join("\n");

async function subagentRoot() {
  const root = await tempDir("clank-edge-sub-");
  await fs.writeFile(path.join(root, ".env"), "ANTHROPIC_API_KEY=sk-test-12345678\n");
  await fs.writeFile(path.join(root, "AGENTS.talk"), SUBAGENT_AGENTS);
  return root;
}

// a fake API that answers each request with the next body, as raw text
async function fakeApi(bodies) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push(JSON.parse(body));
      response.setHeader("content-type", "application/json");
      response.end(bodies.length > 1 ? bodies.shift() : bodies[0]);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: "http://127.0.0.1:" + server.address().port + "/v1/messages", requests, close: () => server.close() };
}

test("subagent: an API answer that is not JSON is a script error, not a crash", async () => {
  const root = await subagentRoot();
  const api = await fakeApi(["<html>proxy error</html>"]);
  try {
    const result = await run("ask_sub", { root, subagentUrl: api.url });
    assert.equal(result.status, "failed");
  } finally {
    api.close();
  }
});

test("subagent: an API answer with no content is a script error, not a crash", async () => {
  const root = await subagentRoot();
  const api = await fakeApi(["{}"]);
  try {
    const result = await run("ask_sub", { root, subagentUrl: api.url });
    assert.equal(result.status, "failed");
  } finally {
    api.close();
  }
});

test("subagent: a lent model that throws is a script error, not a crash", async () => {
  const root = await subagentRoot();
  const lendModel = () => async () => {
    throw new Error("socket hang up");
  };
  const result = await run("ask_sub", { root, lendModel });
  assert.equal(result.status, "failed");
});

test("subagent: a tool call to __proto__ or constructor is an unknown tool", async () => {
  const root = await subagentRoot();
  const api = await fakeApi([
    JSON.stringify({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "__proto__", input: {} }, { type: "tool_use", id: "t2", name: "constructor", input: null }] }),
    JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: "done" }] }),
  ]);
  try {
    const result = await run("ask_sub\nprint it", { root, subagentUrl: api.url });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.output, ["done"]);
    const results = api.requests[1].messages[2].content;
    assert.match(results[0].content, /^There is no tool named __proto__/);
    assert.match(results[1].content, /^There is no tool named constructor/);
  } finally {
    api.close();
  }
});

// ----- help -----

test("ask shows the same choice once", async () => {
  const asked = [];
  const ask = async (request) => {
    asked.push(request.choices);
    return "yes";
  };
  await run("ask 'Go?' with 'yes' or 'yes' or 'no'", { ask });
  assert.deepEqual(asked, [["yes", "no"]]);
});

test("MCP: agent null counts as no agent", async () => {
  const session = mcpSession(await tempDir("clank-edge-mcp-"));
  await mcpCall(session, { script: "set $who to 'main'" });
  const response = await mcpCall(session, { script: "print $who", agent: null });
  assert.equal(response.result.content[0].text, "main");
});

test("subagent: a tool argument that is a list or object goes to the tool as JSON text", async () => {
  const root = await subagentRoot();
  const api = await fakeApi([
    JSON.stringify({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "echo", input: { text: { a: 1 } } }] }),
    JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: "done" }] }),
  ]);
  try {
    const result = await run("ask_sub", { root, subagentUrl: api.url });
    assert.deepEqual(result.errors, []);
    assert.equal(api.requests[1].messages[2].content[0].content, 'echo: {"a":1}');
  } finally {
    api.close();
  }
});

test("help with a command's second word shows the command", async () => {
  const result = await run("help git commit", {});
  assert.deepEqual(result.errors, []);
  assert.match(result.output[0], /git commit/);
});

test("help for words that are Object properties is 'No help', not a crash", async () => {
  for (const word of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    assert.deepEqual(await errorsIn(undefined, "help " + word), ["No help for '" + word + "'. Use help to list everything"]);
  }
});
