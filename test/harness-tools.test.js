import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "../src/js/clank-talk.js";
import { projectHarness, recordHarnessTool, launchAllowed } from "../src/js/runtime.js";
import * as untrusted from "../src/js/untrusted.js";
import { harnessToolAllowed, protectedHarnessPath, harnessMode } from "../src/js/host.js";
import { execFileSync } from "node:child_process";
import { clankTalkExtension } from "../src/js/harnesses/pi-host.js";

// require clank-talk and allow harness tools; see src/md/features/harness-tools.md

// these tests check the defaults, so CLANK_TALK and CLANK_TALK_ALLOW from the shell (such as from mr-klanky) must not change them
delete process.env.CLANK_TALK;
delete process.env.CLANK_TALK_ALLOW;

const dirs = [];

after(async () => {
  for (const dir of dirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function project(text) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "clank-harness-"));
  dirs.push(root);
  if (text !== null) {
    await fs.writeFile(path.join(root, "AGENTS.talk"), text + "\n");
  }
  return root;
}

test("projectHarness reads require clank-talk and allow harness tools from AGENTS.talk", async () => {
  assert.deepEqual(await projectHarness(await project(null)), { agentsTalk: false, required: false, allowed: [], launchAllowed: [], allowedChanges: [], untrusted: [], errors: [] });
  assert.deepEqual(await projectHarness(await project("")), { agentsTalk: true, required: false, allowed: [], launchAllowed: [], allowedChanges: [], untrusted: [], errors: [] });
  const root = await project("require clank-talk\nallow harness tools Read, Grep\nallow untrusted harness tools 'mcp__github__*'");
  assert.deepEqual(await projectHarness(root), { agentsTalk: true, required: true, allowed: ["Read", "Grep", "mcp__github__*"], launchAllowed: [], allowedChanges: [], untrusted: ["mcp__github__*"], errors: [] });
  // a script still runs: the lines are for the harness
  assert.deepEqual((await run("print 1", { root })).errors, []);
});

test("bad forms are clear errors, and the lines are only in AGENTS.talk", async () => {
  // any other require is a policy line
  assert.match((await projectHarness(await project("require taint"))).errors[0], /^'require' is only allowed in a policy file/);
  assert.match((await projectHarness(await project("allow harness Read"))).errors[0], /^Expected 'tools', as in: allow harness tools Read, Grep/);
  assert.match((await projectHarness(await project("allow harness tools"))).errors[0], /^Expected a tool name/);
  const root = await project("import ./more.talk");
  await fs.writeFile(path.join(root, "more.talk"), "allow harness tools Bash\n");
  assert.match((await projectHarness(root)).errors[0], /'allow harness tools' is only allowed in AGENTS.talk/);
});

test("a name matches itself, or a pattern where * is any text", () => {
  assert.equal(harnessToolAllowed("Read", ["Read"]), true);
  assert.equal(harnessToolAllowed("ReadMore", ["Read"]), false);
  assert.equal(harnessToolAllowed("mcp__github__issues", ["mcp__github__*"]), true);
  assert.equal(harnessToolAllowed("mcp__gitlab__issues", ["mcp__github__*"]), false);
  assert.equal(harnessToolAllowed("a.b", ["a*b"]), true);
  assert.equal(harnessToolAllowed("axb", ["a.b"]), false);
});

// a fake pi with five tools, all active at the start
function fakePi() {
  const pi = { handlers: {}, tools: {}, commands: {}, active: ["read", "bash", "write", "mcp_search", "clank_talk"], flags: {} };
  pi.on = (name, handler) => {
    pi.handlers[name] = handler;
  };
  pi.registerTool = (tool) => {
    pi.tools[tool.name] = tool;
  };
  pi.registerCommand = (name, command) => {
    pi.commands[name] = command;
  };
  pi.registerFlag = () => {};
  pi.getFlag = (name) => pi.flags[name];
  pi.setActiveTools = (names) => {
    pi.active = names;
  };
  pi.getActiveTools = () => pi.active;
  pi.getAllTools = () => ["read", "bash", "write", "mcp_search", "clank_talk"].map((name) => ({ name }));
  const Type = { Object: (properties) => ({ type: "object", properties }), String: (options) => ({ type: "string", ...options }), Optional: (schema) => schema };
  clankTalkExtension(pi, Type);
  return pi;
}

test("pi: the tools that AGENTS.talk allows by name are active, and are not blocked", async () => {
  const root = await project("allow harness tools read, 'mcp_*'");
  const pi = fakePi();
  await pi.handlers.session_start({}, { cwd: root });
  assert.deepEqual(pi.active, ["clank_talk", "read", "mcp_search"]);
  assert.equal(await pi.handlers.tool_call({ toolName: "read" }), undefined);
  assert.equal(await pi.handlers.tool_call({ toolName: "mcp_search" }), undefined);
  assert.equal((await pi.handlers.tool_call({ toolName: "bash" })).block, true);
  await pi.handlers.session_shutdown({}, {});
});

test("pi: /clank-talk off and on for the session; with no AGENTS.talk it is off; require clank-talk keeps it on", async () => {
  const said = [];
  const ctx = (cwd) => ({ cwd, hasUI: true, ui: { notify: (text) => said.push(text), setStatus: () => {} } });
  // no AGENTS.talk: off, and nothing is blocked
  const plain = await project(null);
  const pi = fakePi();
  await pi.handlers.session_start({}, ctx(plain));
  assert.deepEqual(pi.active, ["read", "bash", "write", "mcp_search", "clank_talk"]);
  assert.equal(await pi.handlers.tool_call({ toolName: "bash" }), undefined);
  await pi.commands["clank-talk"].handler("", ctx(plain));
  assert.match(said.at(-1), /^ClankTalk: off \(the project has no AGENTS.talk\)\nallowed: clank_talk\nblocked when on: read, bash, write, mcp_search \(4\)$/);
  // on for this session: only clank_talk
  await pi.commands["clank-talk"].handler("on", ctx(plain));
  assert.deepEqual(pi.active, ["clank_talk"]);
  assert.equal((await pi.handlers.tool_call({ toolName: "bash" })).block, true);
  // off again: the tools that pi had
  await pi.commands["clank-talk"].handler(" off ", ctx(plain));
  assert.deepEqual(pi.active, ["read", "bash", "write", "mcp_search", "clank_talk"]);
  // a new session starts from AGENTS.talk again
  await pi.handlers.session_start({}, ctx(await project("")));
  assert.deepEqual(pi.active, ["clank_talk"]);
  // require clank-talk: off is refused
  const required = fakePi();
  await required.handlers.session_start({}, ctx(await project("require clank-talk")));
  await required.commands["clank-talk"].handler("off", ctx(plain));
  assert.match(said.at(-1), /^AGENTS.talk has require clank-talk, so ClankTalk stays on/);
  assert.deepEqual(required.active, ["clank_talk"]);
  await required.commands["clank-talk"].handler("maybe", ctx(plain));
  assert.equal(said.at(-1), "Usage: /clank-talk [on | off]");
});

test("recordHarnessTool writes an audit block, and an untrusted tool's result is an untrusted input", async () => {
  const root = await project("allow untrusted harness tools WebFetch");
  assert.equal(await recordHarnessTool(root, { session: "cc-1", tool: "Read", input: { file_path: "a.txt" }, output: "hello", untrusted: false }), null);
  const ref = await recordHarnessTool(root, { session: "cc-1", tool: "WebFetch", input: { url: "https://example.com/" }, output: "web text", untrusted: true });
  assert.equal(ref, "cc-1/1");
  const [entry] = await untrusted.inputs(root, "cc-1");
  assert.equal(entry.source, 'WebFetch {"url":"https://example.com/"}');
  assert.equal(entry.approved, false);
  const day = (await fs.readdir(path.join(root, ".talk", "audit"))).find((name) => name.endsWith(".log"));
  const log = await fs.readFile(path.join(root, ".talk", "audit", day), "utf8");
  assert.match(log, /== \d\d:\d\d:\d\d  harness tool Read  \(session cc-1\) ==\n  \{"file_path":"a.txt"\}\n--\n  result: 5 characters\n/);
  assert.match(log, /harness tool WebFetch .*\n.*\n--\n  result: 8 characters; untrusted input cc-1\/1\n/);
  // the session is untrusted until the human approves
  assert.deepEqual((await run("print the session is untrusted", { root })).output, ["true"]);
});

test("pi: an allowed tool's run goes in the audit, and an untrusted one taints", async () => {
  const root = await project("allow harness tools read\nallow untrusted harness tools 'mcp_*'");
  const pi = fakePi();
  const ctx = { cwd: root, hasUI: true, ui: { notify: () => {}, setStatus: () => {} } };
  await pi.handlers.session_start({}, ctx);
  await pi.handlers.tool_result({ toolName: "read", input: { path: "a.txt" }, content: [{ type: "text", text: "local text" }] }, ctx);
  assert.equal(await pi.handlers.tool_result({ toolName: "mcp_search", input: { q: "x" }, content: [{ type: "text", text: "found text" }] }, ctx), undefined);
  await pi.handlers.tool_result({ toolName: "clank_talk", input: {}, content: [] }, ctx);
  const sessions = await untrusted.sessions(root);
  assert.equal(sessions.length, 1);
  const entries = await untrusted.inputs(root, sessions[0]);
  assert.deepEqual(entries.map((entry) => entry.source), ['mcp_search {"q":"x"}']);
  const day = (await fs.readdir(path.join(root, ".talk", "audit"))).find((name) => name.endsWith(".log"));
  const log = await fs.readFile(path.join(root, ".talk", "audit", day), "utf8");
  assert.match(log, /harness tool read /);
  assert.doesNotMatch(log, /harness tool clank_talk/);
  await pi.handlers.session_shutdown({}, {});
});

test("clank-talk status-line: on or off from the session's file, else the default; then the taint", async () => {
  const bin = path.resolve("bin/clank-talk.js");
  const line = (root, info) => execFileSync(process.execPath, [bin, "status-line"], { input: JSON.stringify({ workspace: { current_dir: root }, ...info }), env: { ...process.env, CLANK_TALK_ROOT: "" } }).toString().trim();
  const root = await project("");
  assert.equal(line(root, { session_id: "s1" }), "clank-talk: on, untainted");
  await fs.mkdir(path.join(root, ".talk", "harness"), { recursive: true });
  await fs.writeFile(path.join(root, ".talk", "harness", "claude-code-s1.json"), JSON.stringify({ on: false }));
  assert.equal(line(root, { session_id: "s1" }), "clank-talk: off, untainted");
  // a session id that is not a plain name is not a path
  assert.equal(line(root, { session_id: "../s1" }), "clank-talk: on, untainted");
  assert.equal(line(await project(null), {}), "clank-talk: off, untainted");
  // require clank-talk wins over the file
  const required = await project("require clank-talk");
  await fs.mkdir(path.join(required, ".talk", "harness"), { recursive: true });
  await fs.writeFile(path.join(required, ".talk", "harness", "claude-code-s1.json"), JSON.stringify({ on: false }));
  assert.equal(line(required, { session_id: "s1" }), "clank-talk: on, untainted");
});

test("an allowed write or edit never changes .talk/ or a .talk file", async () => {
  assert.equal(protectedHarnessPath("/p", ".talk/untrusted/s/index.json"), true);
  assert.equal(protectedHarnessPath("/p", "/p/.talk"), true);
  assert.equal(protectedHarnessPath("/p", "AGENTS.talk"), true);
  assert.equal(protectedHarnessPath("/p", "src/../.talk/audit/x.log"), true);
  // a disk that ignores case: the root in another case is the same root
  assert.equal(protectedHarnessPath("/Users/p", "/users/p/.talk/taint.json"), true);
  assert.equal(protectedHarnessPath("/Users/p", "/USERS/P/talk/tool.js"), true);
  assert.equal(protectedHarnessPath("/p", "src/app.js"), false);
  // hidden files and folders, as for scripts, unless allow changes to names them
  assert.equal(protectedHarnessPath("/p", ".talkative/x"), true);
  assert.equal(protectedHarnessPath("/p", ".git/hooks/pre-commit"), true);
  assert.equal(protectedHarnessPath("/p", "/P/.Claude/settings.json"), true);
  assert.equal(protectedHarnessPath("/p", "src/.env"), true);
  assert.equal(protectedHarnessPath("/p", ".github/workflows/ci.yml", [".github"]), false);
  assert.equal(protectedHarnessPath("/p", ".github/workflows/ci.yml", [".githubx"]), true);
  assert.equal(protectedHarnessPath("/p", ".talk/x", [".talk"]), true);
  // talk/ holds the tools, and case does not matter, as for scripts
  assert.equal(protectedHarnessPath("/p", "talk/tools.js"), true);
  assert.equal(protectedHarnessPath("/p", "/p/Talk/x.js"), true);
  assert.equal(protectedHarnessPath("/p", "/p/.TALK/audit/x.log"), true);
  assert.equal(protectedHarnessPath("/p", "talkative/x.js"), false);
  // pi: an allowed write to the store is blocked
  const root = await project("allow harness tools write");
  const pi = fakePi();
  await pi.handlers.session_start({}, { cwd: root });
  assert.equal(await pi.handlers.tool_call({ toolName: "write", input: { path: "src/a.js" } }), undefined);
  assert.equal((await pi.handlers.tool_call({ toolName: "write", input: { path: ".talk/untrusted/x/index.json" } })).block, true);
  assert.equal((await pi.handlers.tool_call({ toolName: "write", input: { path: "AGENTS.talk" } })).block, true);
  await pi.handlers.session_shutdown({}, {});
});
test("harnessMode: require wins, then /clank-talk, then CLANK_TALK, then AGENTS.talk", () => {
  const plain = { agentsTalk: true, required: false };
  assert.deepEqual(harnessMode({ ...plain, required: true }, "off", "off"), { on: true, why: "required by AGENTS.talk" });
  assert.deepEqual(harnessMode(plain, "on", "off"), { on: true, why: "from /clank-talk on" });
  assert.deepEqual(harnessMode(plain, null, "off"), { on: false, why: "from CLANK_TALK=off" });
  assert.deepEqual(harnessMode({ ...plain, agentsTalk: false }, null, "on"), { on: true, why: "from CLANK_TALK=on" });
  assert.deepEqual(harnessMode(plain, null, ""), { on: true, why: "the project has an AGENTS.talk" });
  assert.deepEqual(harnessMode(plain, null, "yes"), { on: true, why: "the project has an AGENTS.talk; CLANK_TALK=yes is not on or off, so it is ignored" });
});

test("CLANK_TALK_ALLOW adds to the tools that AGENTS.talk allows", async () => {
  assert.deepEqual(launchAllowed(" mcp__mr-klanky__* , Read,,"), ["mcp__mr-klanky__*", "Read"]);
  assert.deepEqual(launchAllowed(""), []);
  const root = await project("allow harness tools Grep\n");
  process.env.CLANK_TALK_ALLOW = "mcp__mr-klanky__*";
  try {
    const harness = await projectHarness(root);
    assert.deepEqual(harness.allowed, ["Grep", "mcp__mr-klanky__*"]);
    assert.deepEqual(harness.launchAllowed, ["mcp__mr-klanky__*"]);
    assert.ok(harnessToolAllowed("mcp__mr-klanky__inbox", harness.allowed));
  } finally {
    delete process.env.CLANK_TALK_ALLOW;
  }
});

test("clank-talk taint add: text on stdin taints a session, with an audit line", async () => {
  const bin = path.resolve("bin/clank-talk.js");
  const add = (root, ...args) => execFileSync(process.execPath, [bin, "taint", "add", ...args, "--root", root], { input: "a note from agent-3" }).toString().trim();
  const root = await project("");
  assert.equal(add(root, "--session", "claude-code-4f2a", "--source", "mr-klanky: note from agent-3"), "claude-code-4f2a/1");
  const entries = await untrusted.inputs(root, "claude-code-4f2a");
  assert.equal(entries.length, 1);
  assert.match(entries[0].source, /mr-klanky: note from agent-3/);
  const day = (await fs.readdir(path.join(root, ".talk", "audit"))).find((name) => name.endsWith(".log"));
  assert.match(await fs.readFile(path.join(root, ".talk", "audit", day), "utf8"), /harness tool taint add {2}\(session claude-code-4f2a\)/);
  assert.throws(() => add(root, "--session", "../x", "--source", "s"));
});
