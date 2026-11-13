import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import plugin, { ASK_ACTION, askFor } from "../src/js/harnesses/opencode/index.js";
import tuiPlugin from "../src/js/harnesses/opencode/tui.js";
import * as untrusted from "../src/js/untrusted.js";

// the opencode V2 server plugin, with a fake opencode; see src/md/infrastructure/opencode.md

const dirs = [];

after(async () => {
  for (const dir of dirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function project(text) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "clank-opencode-"));
  dirs.push(root);
  if (text !== null) {
    await fs.writeFile(path.join(root, "AGENTS.talk"), text + "\n");
  }
  return root;
}

// a fake opencode context: it keeps what the plugin registers
function fakeContext(root, options = {}) {
  const ctx = { location: { directory: root }, tools: {}, commands: {}, hooks: {}, said: [], asserted: [] };
  ctx.tool = {
    transform: async (callback) => callback({ add: (tool) => (ctx.tools[tool.name] = tool) }),
    hook: async (name, callback) => (ctx.hooks["tool." + name] = callback),
    list: async () => ["clank_talk", "read", "shell", "webfetch", "question"].map((id) => ({ id })),
  };
  ctx.session = {
    hook: async (name, callback) => (ctx.hooks["session." + name] = callback),
  };
  ctx.permission = {
    hook: async (name, callback) => (ctx.hooks["permission." + name] = callback),
    assert: async (request) => {
      ctx.asserted.push(request);
      if (options.deny) {
        throw Object.assign(new Error("denied"), { _tag: "Tool.Error" });
      }
      if (options.reject) {
        throw new Error("the user stopped");
      }
    },
  };
  return ctx;
}

const tools = () => ({ clank_talk: {}, read: {}, shell: {}, webfetch: {}, question: {} });

// a fake opencode TUI context: the commands from keymap.layer, toasts, alerts, and a select that the test answers
function fakeTui(root, sessionID = "s1") {
  const tui = { location: { directory: root }, layers: [], toasts: [], alerts: [], opened: [], choose: async () => undefined };
  tui.keymap = { layer: (factory) => tui.layers.push(factory()) };
  tui.ui = {
    toast: { show: (toast) => tui.toasts.push(toast) },
    router: { current: () => (sessionID === null ? { type: "home" } : { type: "session", sessionID }) },
    dialog: {
      alert: async (alert) => tui.alerts.push(alert),
      select: async (dialog) => tui.choose(dialog),
      clear: () => {},
    },
  };
  tui.command = (name) => tui.layers.flatMap((layer) => layer.commands).find((command) => command.slash && command.slash.name === name);
  return tui;
}

test("the default export has the id and setup that opencode V2 reads", () => {
  assert.equal(plugin.id, "clank-talk");
  assert.equal(typeof plugin.setup, "function");
});

test("clank_talk runs a script; with an AGENTS.talk the other tools are hidden and denied", async () => {
  const root = await project("allow harness tools read");
  const ctx = fakeContext(root);
  const cleanup = await plugin.setup(ctx);
  assert.equal(ctx.tools.clank_talk.options.codemode, false);
  const result = await ctx.tools.clank_talk.execute({ script: "# add\nprint 1 + 1" }, { sessionID: "s1" });
  assert.equal(result.content, "2");
  const event = { sessionID: "s1", tools: tools() };
  await ctx.hooks["session.context"](event);
  assert.deepEqual(Object.keys(event.tools), ["clank_talk", "read", "question"]);
  const shell = { sessionID: "s1", action: "shell", effect: "allow" };
  await ctx.hooks["permission.evaluate"](shell);
  assert.equal(shell.effect, "deny");
  assert.match(shell.message, /allow harness tools shell/);
  const read = { sessionID: "s1", action: "read", effect: "allow" };
  await ctx.hooks["permission.evaluate"](read);
  assert.equal(read.effect, "allow");
  cleanup();
});

test("TUI part: /clank-talk off and on for one session; the server part reads it; require clank-talk keeps it on", async () => {
  const root = await project(null);
  const ctx = fakeContext(root);
  await plugin.setup(ctx);
  const off = { sessionID: "s1", tools: tools() };
  await ctx.hooks["session.context"](off);
  assert.equal(Object.keys(off.tools).length, 5);
  const tui = fakeTui(root, "s1");
  await tuiPlugin.setup(tui);
  await tui.command("clank-talk").run("");
  assert.match(tui.alerts.at(-1).message, /^ClankTalk: off \(the project has no AGENTS.talk\)\nallowed: clank_talk, question\n.*\ntaint: untainted$/);
  await tui.command("clank-talk").run("on");
  assert.equal(tui.toasts.at(-1).message, "ClankTalk is on for this session. Other tools are hidden and blocked.");
  const on = { sessionID: "s1", tools: tools() };
  await ctx.hooks["session.context"](on);
  assert.deepEqual(Object.keys(on.tools), ["clank_talk", "question"]);
  const shell = { sessionID: "s1", action: "shell", effect: "allow" };
  await ctx.hooks["permission.evaluate"](shell);
  assert.equal(shell.effect, "deny");
  // another session is still off
  const other = { sessionID: "s2", tools: tools() };
  await ctx.hooks["session.context"](other);
  assert.equal(Object.keys(other.tools).length, 5);
  // no session open: on and off need one
  const home = fakeTui(root, null);
  await tuiPlugin.setup(home);
  await home.command("clank-talk").run("off");
  assert.match(home.toasts.at(-1).message, /^Open a session first/);
  const required = fakeTui(await project("require clank-talk"), "s1");
  await tuiPlugin.setup(required);
  await required.command("clank-talk").run("off");
  assert.match(required.toasts.at(-1).message, /^AGENTS.talk has require clank-talk, so ClankTalk stays on/);
});

test("ask: a yes or no question is opencode's permission prompt, and the plugin always makes it ask", async () => {
  const ctx = fakeContext(await project(""));
  const context = { sessionID: "s1", agent: "build", messageID: "m1", id: "t1" };
  assert.equal(await askFor(ctx, context)({ question: "Push?", choices: ["no", "yes"] }), "yes");
  assert.equal(ctx.asserted[0].action, ASK_ACTION);
  assert.deepEqual(ctx.asserted[0].resources, ["Push?"]);
  assert.equal(await askFor(ctx, context)({ question: "Fetch?", choices: ["yes, once", "yes, for this session", "no"] }), "yes, once");
  assert.equal(await askFor(fakeContext(await project(""), { deny: true }), context)({ question: "Push?", choices: ["yes", "no"] }), "no");
  // a plain rejection ends the step: the tool throws after the script
  const rejecting = fakeContext(await project(""), { reject: true });
  await plugin.setup(rejecting);
  await assert.rejects(rejecting.tools.clank_talk.execute({ script: "ask 'Push?' with 'yes' or 'no'\nprint 'after'" }, context), /the user stopped/);
  // other questions give no answer for now
  assert.equal(await askFor(ctx, context)({ question: "Deploy where?", choices: ["staging", "production"] }), null);
  assert.equal(await askFor(ctx, context)({ question: "Name?", choices: [] }), null);
  // a rule that allows everything does not answer ClankTalk's questions
  await plugin.setup(ctx);
  const event = { sessionID: "s1", action: ASK_ACTION, effect: "allow" };
  await ctx.hooks["permission.evaluate"](event);
  assert.equal(event.effect, "ask");
});

test("an allowed tool goes in the audit, and an untrusted one taints; the TUI review opens and approves it", async () => {
  const root = await project("allow harness tools read\nallow untrusted harness tools webfetch");
  const ctx = fakeContext(root);
  await plugin.setup(ctx);
  await ctx.hooks["tool.execute.after"]({ sessionID: "s1", tool: "read", input: { path: "a.txt" }, status: "completed", result: { content: "local" } });
  await ctx.hooks["tool.execute.after"]({ sessionID: "s1", tool: "webfetch", input: { url: "https://example.com/" }, status: "completed", result: { content: [{ type: "text", text: "web" }] } });
  const sessions = await untrusted.sessions(root);
  assert.equal(sessions.length, 1);
  assert.deepEqual((await untrusted.inputs(root, sessions[0])).map((entry) => entry.source), ['webfetch {"url":"https://example.com/"}']);
  // the TUI part's review: ctrl+o opens a page, ctrl+a approves
  const tui = fakeTui(root);
  await tuiPlugin.setup(tui, { open: async (file) => tui.opened.push(file) });
  tui.choose = async (dialog) => {
    assert.equal(dialog.title, "Untrusted inputs (1 not approved)");
    assert.equal(dialog.options[0].title, 'webfetch {"url":"https://example.com/"}');
    await dialog.actions.find((action) => action.bind === "ctrl+o").onTrigger(dialog.options[0].value);
    tui.choose = async () => undefined;
    await dialog.actions.find((action) => action.bind === "ctrl+a").onTrigger(dialog.options[0].value);
    return undefined;
  };
  await tui.command("taint").run("");
  assert.match(tui.opened[0], /\.talk[\\/]untrusted[\\/].+[\\/]1\.html$/);
  assert.deepEqual(tui.toasts.slice(-2).map((toast) => toast.message), ["Approved " + sessions[0] + "/1", "No untrusted inputs to approve."]);
  assert.equal((await untrusted.inputs(root, sessions[0]))[0].approvedBy, "the opencode review");
});

test("TUI part: /taint clear approves all, with a toast", async () => {
  const root = await project("allow untrusted harness tools webfetch");
  const ctx = fakeContext(root);
  await plugin.setup(ctx);
  await ctx.hooks["tool.execute.after"]({ sessionID: "s1", tool: "webfetch", input: { url: "https://example.com/" }, status: "completed", result: { content: "web" } });
  const tui = fakeTui(root);
  await tuiPlugin.setup(tui);
  await tui.command("taint").run("clear");
  assert.match(tui.toasts.at(-1).message, /^Approved 1 input: webfetch/);
  await tui.command("taint").run("wipe");
  assert.equal(tui.toasts.at(-1).message, "Usage: /taint [clear]");
});

// a fake opencode RPC: the server part's register, and the TUI part's client.rpc, joined in one process
function fakeRpc() {
  const rpc = { handlers: null, listeners: [], emitted: [] };
  rpc.register = async (definition, handlers) => {
    assert.equal(definition.id, "clank-talk");
    rpc.handlers = handlers;
    return { events: { emit: async (name, data) => {
      rpc.emitted.push({ name, data });
      for (const listener of rpc.listeners) {
        listener({ type: "rpc.clank-talk." + name, data, location: { directory: rpc.root } });
      }
    } } };
  };
  rpc.client = () => ({
    seen: (input) => rpc.handlers.seen(input),
    answer: (input) => rpc.handlers.answer(input),
    events: { on: (name, listener) => (rpc.listeners.push(listener), () => (rpc.listeners = rpc.listeners.filter((each) => each !== listener))) },
  });
  return rpc;
}

test("ask with real choices: the TUI part shows a select dialog, a confirm for each choice, or a prompt", async () => {
  const root = await project("");
  const rpc = fakeRpc();
  rpc.root = root;
  const ctx = fakeContext(root);
  ctx.rpc = { register: rpc.register };
  await plugin.setup(ctx);
  const tui = fakeTui(root);
  tui.client = { rpc: rpc.client };
  const asked = [];
  tui.choose = async (dialog) => {
    asked.push(dialog);
    return dialog.options[1].value;
  };
  tui.ui.dialog.confirm = async ({ message }) => message.startsWith("b.js");
  tui.ui.dialog.prompt = async () => "blue";
  const stop = await tuiPlugin.setup(tui);
  const run = async (script) => (await ctx.tools.clank_talk.execute({ script: "# ask\n" + script }, { sessionID: "s1" })).content;
  assert.equal(await run("ask 'Deploy where?' with 'staging: the test site' or 'production: the live site'\nprint it"), "production");
  assert.equal(asked[0].title, "Deploy where?");
  assert.deepEqual(asked[0].options.map((option) => option.title), ["staging: the test site", "production: the live site"]);
  assert.equal(await run("ask 'Commit which?' with any of 'a.js' or 'b.js'\nprint it as json"), '["b.js"]');
  assert.equal(await run("ask 'Which color?'\nprint it"), "blue");
  // Escape is no answer
  tui.choose = async () => undefined;
  assert.equal(await run("ask 'Deploy where?' with 'staging' or 'production'\nprint it"), "null");
  // an answer for an id that is gone does nothing
  assert.deepEqual(await rpc.handlers.answer({ id: rpc.emitted[0].data.id, answer: "staging" }), { ok: false });
  // no TUI listens: after SEEN_WITHIN_MS, the permission prompt; a yes or no question gets yes
  stop();
  const started = Date.now();
  assert.equal(await run("ask 'Push?' with 'no' or 'yes'\nprint it"), "yes");
  assert.ok(Date.now() - started >= 1900);
  assert.equal(ctx.asserted.at(-1).action, ASK_ACTION);
});