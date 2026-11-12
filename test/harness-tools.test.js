import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "../src/js/clank-talk.js";
import { projectHarness } from "../src/js/runtime.js";
import { harnessToolAllowed } from "../src/js/host.js";
import { clankTalkExtension } from "../src/js/harnesses/pi-host.js";

// require clank-talk and allow harness tools; see src/md/features/harness-tools.md

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
  assert.deepEqual(await projectHarness(await project(null)), { agentsTalk: false, required: false, allowed: [], errors: [] });
  assert.deepEqual(await projectHarness(await project("")), { agentsTalk: true, required: false, allowed: [], errors: [] });
  const root = await project("require clank-talk\nallow harness tools Read, Grep\nallow harness tools 'mcp__github__*'");
  assert.deepEqual(await projectHarness(root), { agentsTalk: true, required: true, allowed: ["Read", "Grep", "mcp__github__*"], errors: [] });
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

test("pi: the tools that AGENTS.talk allows by name are active, and are not blocked", async () => {
  const root = await project("allow harness tools read, 'mcp_*'");
  const pi = { handlers: {}, tools: {}, active: null, flags: {} };
  pi.on = (name, handler) => {
    pi.handlers[name] = handler;
  };
  pi.registerTool = (tool) => {
    pi.tools[tool.name] = tool;
  };
  pi.registerCommand = () => {};
  pi.registerFlag = () => {};
  pi.getFlag = (name) => pi.flags[name];
  pi.setActiveTools = (names) => {
    pi.active = names;
  };
  pi.getAllTools = () => ["read", "bash", "write", "mcp_search", "clank_talk"].map((name) => ({ name }));
  const Type = { Object: (properties) => ({ type: "object", properties }), String: (options) => ({ type: "string", ...options }), Optional: (schema) => schema };
  clankTalkExtension(pi, Type);
  await pi.handlers.session_start({}, { cwd: root });
  assert.deepEqual(pi.active, ["clank_talk", "read", "mcp_search"]);
  assert.equal(await pi.handlers.tool_call({ toolName: "read" }), undefined);
  assert.equal(await pi.handlers.tool_call({ toolName: "mcp_search" }), undefined);
  assert.equal((await pi.handlers.tool_call({ toolName: "bash" })).block, true);
  await pi.handlers.session_shutdown({}, {});
});
