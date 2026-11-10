import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clankTalkExtension } from "../src/js/pi-host.js";

// a fake pi: it keeps what the extension registers
function fakePi() {
  const pi = { handlers: {}, tools: {}, active: null };
  pi.on = (name, handler) => {
    pi.handlers[name] = handler;
  };
  pi.registerTool = (tool) => {
    pi.tools[tool.name] = tool;
  };
  pi.setActiveTools = (names) => {
    pi.active = names;
  };
  return pi;
}

// a fake TypeBox: plain JSON schema
const Type = {
  Object: (properties) => ({ type: "object", properties }),
  String: (options) => ({ type: "string", ...options }),
  Optional: (schema) => ({ ...schema, optional: true }),
};

let root;
let pi;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "clank-pi-"));
  pi = fakePi();
  clankTalkExtension(pi, Type);
  await pi.handlers.session_start({}, { cwd: root });
});

after(async () => {
  await pi.handlers.session_shutdown({}, {});
  await fs.rm(root, { recursive: true, force: true });
});

async function call(script, ctx = { cwd: root, hasUI: false }) {
  return await pi.tools.clank_talk.execute("id-1", { script }, undefined, undefined, ctx);
}

test("clank_talk is the only tool: the others are blocked", async () => {
  assert.deepEqual(pi.active, ["clank_talk"]);
  assert.equal(await pi.handlers.tool_call({ toolName: "clank_talk" }), undefined);
  const blocked = await pi.handlers.tool_call({ toolName: "bash" });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /Only clank_talk/);
  assert.equal((await pi.handlers.tool_call({ toolName: "mcp__other__x" })).block, true);
});

test("the tool runs a script, and gives the same text as the MCP server", async () => {
  const result = await call("print 1 + 1");
  assert.deepEqual(result.content, [{ type: "text", text: "2" }]);
  assert.equal(result.isError, false);
  assert.equal(result.details.status, "done");
  const failed = await call("print 2 * 'x'");
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /--- failed ---\n1:9 Expected a number/);
  assert.equal(pi.tools.clank_talk.executionMode, "sequential");
  assert.match(pi.tools.clank_talk.description, /^Run a ClankTalk script/);
});

test("$ globals stay between calls, as in the MCP server", async () => {
  await call("set $count to 5");
  assert.equal((await call("print $count")).content[0].text, "5");
});

test("ask goes to a pi dialog, and with no UI the answer is null", async () => {
  const asked = [];
  const ui = {
    select: async (question, choices) => {
      asked.push([question, choices]);
      return "yes";
    },
    input: async (question) => {
      asked.push([question]);
      return "blue";
    },
  };
  const ctx = { cwd: root, hasUI: true, ui };
  assert.equal((await call("ask 'Is this a test?' with 'yes' or 'no'\nprint it", ctx)).content[0].text, "yes");
  assert.equal((await call("ask 'Which color?'\nprint it", ctx)).content[0].text, "blue");
  assert.deepEqual(asked, [["Is this a test?", ["yes", "no"]], ["Which color?"]]);
  assert.equal((await call("ask 'Is this a test?' with 'yes' or 'no'\nprint it")).content[0].text, "null");
  ui.select = async () => undefined;
  assert.equal((await call("ask 'Is this a test?' with 'yes' or 'no'\nprint it", ctx)).content[0].text, "null");
});

test("a bad agent name is an error", async () => {
  const result = await pi.tools.clank_talk.execute("id-2", { script: "print 1", agent: "a b" }, undefined, undefined, { cwd: root });
  assert.equal(result.isError, true);
});
