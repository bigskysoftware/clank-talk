// pi host: runs ClankTalk inside pi, as the only tool; see src/md/infrastructure/pi.md
// pi.js is the entry file. It gives this module pi's TypeBox, so the tests can run without pi.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { run, stopAllProcesses } from "../clank-talk.js";
import { projectHarness, recordHarnessTool } from "../runtime.js";
import * as untrusted from "../untrusted.js";
import { SubagentError, schemaFor } from "../subagent.js";
import { SYNTAX, describeTool, formatResult, AGENT_NAME, agentScope, MAX_STEPS, keptOutput, sessionName, loadPolicy, projectRoot, harnessToolAllowed } from "../host.js";

const TOOL_NAME = "clank_talk";

// the human's command line, for /taint: it runs the full-screen review in its own process
const CLI = fileURLToPath(new URL("../../../bin/clank-talk.js", import.meta.url));

// the key of the taint count in pi's footer
const STATUS_KEY = "clank-talk";

// send progress at most this often while a script runs
const PROGRESS_EVERY_MS = 500;

/**
 * Set up the extension: the clank_talk tool, and a guard that blocks every other tool.
 * @param {Object} pi    pi's ExtensionAPI
 * @param {Object} Type  TypeBox's Type, for the tool parameters
 * @param {Object} [options]
 * @param {Function} [options.spawn]  for tests: in place of spawnSync, for /taint
 */
export function clankTalkExtension(pi, Type, options = {}) {
  const spawn = options.spawn || spawnSync;
  // one session, as in the MCP server: $ globals, reads, undo, fetch approvals, processes and the audit
  let session = null;
  // the project's settings from AGENTS.talk: is there one, require clank-talk, allow harness tools
  let harness = { agentsTalk: false, required: false, allowed: [], errors: [] };
  // /clank-talk on or off, for this session only; null: the default from AGENTS.talk
  let switched = null;
  // the tools that pi had active before ClankTalk, for /clank-talk off
  let startTools = [];

  // on or off, and why: require clank-talk wins, then /clank-talk on or off, then on when there is an AGENTS.talk
  function mode() {
    if (harness.required) {
      return { on: true, why: "required by AGENTS.talk" };
    }
    if (switched !== null) {
      return { on: switched === "on", why: "from /clank-talk " + switched };
    }
    return harness.agentsTalk ? { on: true, why: "the project has an AGENTS.talk" } : { on: false, why: "the project has no AGENTS.talk" };
  }

  // the tools the model sees: while on, clank_talk and the tools that AGENTS.talk allows; while off, what pi had
  function applyTools() {
    const all = typeof pi.getAllTools === "function" ? pi.getAllTools().map((tool) => tool.name) : [];
    if (mode().on) {
      pi.setActiveTools([TOOL_NAME, ...all.filter((name) => name !== TOOL_NAME && harnessToolAllowed(name, harness.allowed))]);
    } else {
      pi.setActiveTools(startTools.includes(TOOL_NAME) ? startTools : [...startTools, TOOL_NAME]);
    }
  }

  // a harness policy, as the MCP server's --policy and --policy-hash; see src/md/features/policy.md
  pi.registerFlag("clank-policy", { description: "A ClankTalk policy file for this session", type: "string" });
  pi.registerFlag("clank-policy-hash", { description: "The sha256 of the policy file; if it does not match, ClankTalk refuses every call", type: "string" });

  pi.on("session_start", async (_event, ctx) => {
    // the root: CLANK_TALK_ROOT, or the folder where pi starts
    session = newSession(projectRoot(null, ctx.cwd));
    // pi gives the flag values only after loading, so the policy is read here
    const file = pi.getFlag("clank-policy");
    const hash = pi.getFlag("clank-policy-hash");
    const loaded = loadPolicy(file ? file : null, hash ? hash : null, { file: "--clank-policy", hash: "--clank-policy-hash", stops: "ClankTalk refuses every call" });
    session.policy = loaded.policy || null;
    session.policyError = loaded.error || null;
    // register the tool again, now with the tools from this project's AGENTS.talk in its description
    registerClankTalk(await describeTool(session.root));
    // while ClankTalk is on, it is the only tool the model sees, with the tools that AGENTS.talk allows by name
    // if AGENTS.talk cannot be read, it stays on with no other tools: fail closed
    try {
      harness = await projectHarness(session.root);
    } catch (err) {
      harness = { agentsTalk: true, required: false, allowed: [], errors: [err.message] };
    }
    switched = null;
    startTools = typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
    applyTools();
    await showTaint(ctx, session.root);
  });

  // the count in the footer changes when a script reads web text, and when the human approves
  pi.on("tool_execution_end", async (event, ctx) => {
    if (session !== null) {
      await showTaint(ctx, session.root);
    }
  });

  // an allowed harness tool goes in the ClankTalk audit; an untrusted one's result taints; see src/md/features/harness-tools.md
  // tool_result has the input and the content (pi docs, Events); it changes nothing in the result
  pi.on("tool_result", async (event, ctx) => {
    if (session === null || !mode().on || event.toolName === TOOL_NAME || !harnessToolAllowed(event.toolName, harness.allowed)) {
      return undefined;
    }
    const blocks = Array.isArray(event.content) ? event.content : [];
    const text = blocks.map((block) => (block && block.type === "text" ? block.text : "[" + (block && block.type) + "]")).join("\n");
    try {
      await recordHarnessTool(session.root, { session: session.name, tool: event.toolName, input: event.input ?? null, output: text, untrusted: harnessToolAllowed(event.toolName, harness.untrusted || []) });
    } catch (err) {
      if (ctx && ctx.hasUI) {
        ctx.ui.notify("ClankTalk could not record " + event.toolName + ": " + err.message, "warning");
      }
    }
    return undefined;
  });
  pi.on("agent_end", async (_event, ctx) => {
    if (session !== null) {
      await showTaint(ctx, session.root);
    }
  });

  // /taint: the full-screen review over pi; see src/md/features/taint.md
  // only the human can type a command, so the model cannot approve through it
  pi.registerCommand("taint", {
    description: "Review and approve the untrusted inputs of this project, full screen",
    handler: async (_args, ctx) => {
      const root = session !== null ? session.root : projectRoot(null, ctx.cwd);
      if (!ctx.hasUI) {
        return;
      }
      await ctx.ui.custom((tui, _theme, _keybindings, done) => {
        // pi gives up the terminal while the review runs, and draws itself again after
        tui.stop();
        const result = spawn(process.execPath, [CLI, "taint", "--tui", "--root", root], { stdio: "inherit", env: process.env });
        tui.start();
        tui.requestRender(true);
        done(result.status);
        return { render: () => [], invalidate: () => {} };
      });
      await showTaint(ctx, root);
    },
  });

  pi.on("session_shutdown", async () => {
    if (session !== null) {
      stopAllProcesses(session.processes);
    }
  });

  // while ClankTalk is on, block every other tool: built-in tools, MCP tools, and calls from codemode
  pi.on("tool_call", async (event) => {
    if (mode().on && event.toolName !== TOOL_NAME && !harnessToolAllowed(event.toolName, harness.allowed)) {
      return { block: true, reason: "Only clank_talk is allowed here. Do the work in a ClankTalk script. To allow the tool, the human can add a line to AGENTS.talk: allow harness tools " + event.toolName };
    }
    return undefined;
  });

  // /clank-talk on | off for this session, or a report; see src/md/features/harness-tools.md
  // only the human can type a command, so the model cannot turn ClankTalk off
  pi.registerCommand("clank-talk", {
    description: "ClankTalk only: on, off, or show which tools are allowed",
    handler: async (args, ctx) => {
      const say = (text, type = "info") => (ctx && ctx.hasUI ? ctx.ui.notify(text, type) : undefined);
      const arg = String(args || "").trim();
      if (arg === "on" || arg === "off") {
        if (arg === "off" && harness.required) {
          say("AGENTS.talk has require clank-talk, so ClankTalk stays on. To turn it off, remove that line.", "warning");
          return;
        }
        switched = arg;
        applyTools();
        say("ClankTalk is " + arg + " for this session." + (arg === "on" ? " Other tools are blocked; /clank-talk shows which." : ""));
        return;
      }
      if (arg !== "") {
        say("Usage: /clank-talk [on | off]", "warning");
        return;
      }
      const state = mode();
      const names = typeof pi.getAllTools === "function" ? pi.getAllTools().map((tool) => tool.name) : [];
      const allowed = names.filter((name) => name === TOOL_NAME || harnessToolAllowed(name, harness.allowed));
      const blocked = names.filter((name) => !allowed.includes(name));
      const lines = [
        "ClankTalk: " + (state.on ? "on" : "off") + " (" + state.why + ")",
        "allowed: " + (allowed.join(", ") || "none"),
        (state.on ? "blocked: " : "blocked when on: ") + (blocked.length === 0 ? "none" : blocked.join(", ") + " (" + blocked.length + ")"),
      ];
      if (harness.allowed.length > 0) {
        lines.push("AGENTS.talk allows: " + harness.allowed.join(", "));
      }
      for (const error of harness.errors) {
        lines.push("AGENTS.talk error: " + error);
      }
      say(lines.join("\n"));
    },
  });

  // pi registers the tool before it knows the project, so the first description has no AGENTS.talk tools;
  // session_start registers it again with them, and a second registerTool replaces the first
  registerClankTalk(SYNTAX + "\n\nhelp tools lists the tools from AGENTS.talk.");

  function registerClankTalk(description) {
    pi.registerTool({
      name: TOOL_NAME,
      label: "ClankTalk",
      description,
      parameters: Type.Object({
        script: Type.String({ description: "The ClankTalk script to run" }),
        agent: Type.Optional(Type.String({ description: "Your name, if you are one of several agents, such as 'tester'. Each name has its own undo list and $ globals." })),
      }),
      // calls share the globals, the undo list and the reads, so they run one at a time
      executionMode: "sequential",
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        if (session === null) {
          session = newSession(projectRoot(null, ctx.cwd));
        }
        if (session.policyError) {
          return { content: [{ type: "text", text: "ClankTalk does not run: " + session.policyError }], details: {}, isError: true };
        }
        const agent = params.agent;
        if (agent !== undefined && !AGENT_NAME.test(agent)) {
          return { content: [{ type: "text", text: "The argument 'agent' must be a name of 1 to 40 letters, digits, -, _ or ." }], details: {}, isError: true };
        }
        const scope = agentScope(session, agent);
        const result = await run(params.script, {
          root: session.root,
          globals: scope.globals,
          seen: scope.seen,
          undo: scope.undo,
          agent: agent || null,
          policy: session.policy,
          fetchHosts: session.fetchHosts,
          processes: session.processes,
          audit: session.audit,
          ask: askFor(ctx),
          harness: "pi",
          lendModel: lendModelFor(ctx),
          maxSteps: MAX_STEPS,
          onStep: progressFor(onUpdate),
          signal,
          previousOutput: scope.output.text,
          session: session.name,
        });
        scope.output.text = keptOutput(result);
        return {
          content: [{ type: "text", text: formatResult(result, params.script, session.root) }],
          details: { status: result.status, steps: result.steps },
          isError: result.status !== "done",
        };
      },
    });
  }
}

// the footer: the count of inputs that are not approved, or nothing
async function showTaint(ctx, root) {
  if (!ctx || !ctx.hasUI) {
    return;
  }
  let count = 0;
  try {
    count = (await untrusted.pendingAll(root)).length;
  } catch {
    // no store yet, or one that cannot be read: show no count
  }
  ctx.ui.setStatus(STATUS_KEY, count === 0 ? undefined : "taint: " + count + " not approved (/taint)");
}

function newSession(root) {
  return { root, name: sessionName("pi"), globals: Object.create(null), seen: new Map(), undo: [], fetchHosts: new Set(), processes: new Map(), audit: { scripts: 0, records: [] } };
}

// a subagent uses pi's own model and login, so it needs no API key; see src/md/features/subagents.md
// name is null for pi's current model, "provider/id", or a bare model id
export function lendModelFor(ctx) {
  if (!ctx || !ctx.modelRegistry) {
    return null;
  }
  return (name) => {
    const model = name === null ? ctx.model : findModel(ctx, name);
    if (!model) {
      throw new Error(name === null ? "pi has no model selected for the subagent" : "pi does not know the model " + name + ". Use a name from /model, such as anthropic/claude-sonnet-5-5");
    }
    return async ({ system, tools, history, signal }) => {
      const context = {
        systemPrompt: system,
        tools: tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: schemaFor(tool) })),
        messages: history.flatMap(piMessages),
      };
      const reply = await ctx.modelRegistry.complete(model, context, { signal });
      if (reply.stopReason === "error" || reply.stopReason === "aborted") {
        throw new SubagentError("The model failed: " + (reply.errorMessage || reply.stopReason));
      }
      const text = reply.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
      const calls = reply.content.filter((block) => block.type === "toolCall").map((block) => ({ id: block.id, name: block.name, input: block.arguments }));
      const stops = { toolUse: "tool_use", length: "too_long" };
      return { stop: stops[reply.stopReason] || "end", text, calls, raw: reply };
    };
  };
}

function findModel(ctx, name) {
  const slash = name.indexOf("/");
  if (slash > 0) {
    return ctx.modelRegistry.find(name.slice(0, slash), name.slice(slash + 1));
  }
  return ctx.modelRegistry.getAvailable().find((model) => model.id === name);
}

// the neutral history as pi messages: the assistant's reply goes back as it came
function piMessages(message) {
  const timestamp = Date.now();
  if (message.role === "user") {
    return [{ role: "user", content: message.text, timestamp }];
  }
  if (message.role === "assistant") {
    return [message.raw];
  }
  return message.results.map((result) => ({
    role: "toolResult",
    toolCallId: result.id,
    toolName: result.name,
    content: [{ type: "text", text: result.content }],
    isError: result.isError,
    timestamp,
  }));
}

// "ask" in a script goes to a pi dialog, so the human answers, never the model
// with no UI (print and JSON modes), there is no ask, so the answer is null: no
function askFor(ctx) {
  if (!ctx || !ctx.hasUI) {
    return null;
  }
  return async ({ question, choices, fields, many, signal }) => {
    // several choices: pi has no multi-select, so one yes or no dialog for each choice
    if (many) {
      const picked = [];
      for (const choice of choices) {
        if ((await ctx.ui.confirm(choice + "?", question, { signal })) === true) {
          picked.push(choice);
        }
      }
      return picked;
    }
    // a form of yes or no boxes, such as taint review: pi has no form, so one yes or no dialog for each box
    // each dialog shows the question; a dialog that the human closes is no
    if (fields) {
      const content = {};
      for (const field of fields) {
        content[field.name] = (await ctx.ui.confirm(field.title + "?", question, { signal })) === true;
      }
      return content;
    }
    let answer;
    if (choices.length > 0) {
      answer = await ctx.ui.select(question, choices, { signal });
    } else {
      answer = await ctx.ui.input(question, "", { signal });
    }
    if (typeof answer !== "string") {
      return null;
    }
    return answer;
  };
}

// where the script is, for pi's progress line; at most once each PROGRESS_EVERY_MS
function progressFor(onUpdate) {
  if (typeof onUpdate !== "function") {
    return null;
  }
  let last = 0;
  return (step) => {
    const now = Date.now();
    if (now - last < PROGRESS_EVERY_MS) {
      return;
    }
    last = now;
    onUpdate({ content: [{ type: "text", text: "line " + step.line + ": " + step.type + " (step " + step.steps + ")" }], details: {} });
  };
}
