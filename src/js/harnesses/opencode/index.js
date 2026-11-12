// opencode host: ClankTalk as an opencode V2 server plugin; see src/md/infrastructure/opencode.md
// Load it from opencode.jsonc: "plugins": ["<path to clank-talk>/src/js/harnesses/opencode"]
// V2 reads the default export's id and setup(); no @opencode/plugin import is needed (opencode docs, Plugins, Support V1)

import { run, stopAllProcesses } from "../../clank-talk.js";
import { describeTool, formatResult, AGENT_NAME, agentScope, MAX_STEPS, keptOutput, sessionName, projectRoot, harnessToolAllowed } from "../../host.js";
import { projectHarness, recordHarnessTool } from "../../runtime.js";
import { sessionMode } from "./state.js";
import { ClankTalkChannel, SEEN_WITHIN_MS } from "./channel.js";
import { randomBytes } from "node:crypto";

export const TOOL_NAME = "clank_talk";
// the permission action of ClankTalk's own questions: the plugin always makes it a prompt for the human
export const ASK_ACTION = "clank_talk_ask";
// permission actions that only talk to the human
const BUILT_IN = ["question"];

/**
 * Set up the plugin.
 * @param {Object} ctx  opencode's plugin context
 */
export async function setup(ctx) {
  const root = projectRoot(null, (ctx.location && ctx.location.directory) || process.cwd());
  // one ClankTalk session for each opencode session: $ globals, reads, undo, fetch approvals, processes, the audit, and /clank-talk on or off
  const sessions = new Map();
  let harness = await readHarness(root);

  function sessionFor(sessionID) {
    let session = sessions.get(sessionID);
    if (session === undefined) {
      session = { root, name: sessionName("opencode"), globals: Object.create(null), seen: new Map(), undo: [], fetchHosts: new Set(), processes: new Map(), audit: { scripts: 0, records: [] } };
      sessions.set(sessionID, session);
    }
    return session;
  }

  // the channel to the TUI part, for ask with real choices; null if opencode has no RPC here
  const pending = new Map();
  let channel = null;
  try {
    const registration = await ctx.rpc.register(ClankTalkChannel, {
      seen: async (input) => {
        const waiting = pending.get(input && input.id);
        if (waiting !== undefined) {
          waiting.seen();
        }
        return {};
      },
      // each id works once: an answer for a question that is gone, or a guessed id, does nothing
      answer: async (input) => {
        const waiting = pending.get(input && input.id);
        if (waiting === undefined) {
          return { ok: false };
        }
        pending.delete(input.id);
        waiting.answer(input.answer === undefined ? null : input.answer);
        return { ok: true };
      },
    });
    channel = { emit: (name, data) => registration.events.emit(name, data), pending };
  } catch {
    channel = null;
  }
  // on or off for one session, from the file that /clank-talk in the TUI part writes; see state.js
  const mode = (sessionID) => sessionMode(root, sessionID, harness);

  const allowed = (name) => name === TOOL_NAME || BUILT_IN.includes(name) || harnessToolAllowed(name, harness.allowed);

  // the tool: a ClankTalk script, run in this process
  await ctx.tool.transform((editor) => {
    editor.add({
      name: TOOL_NAME,
      description: harness.description,
      input: {
        type: "object",
        properties: {
          script: { type: "string", description: "The ClankTalk script to run" },
          agent: { type: "string", description: "Your name, if you are one of several agents, such as 'tester'. Each name has its own undo list and $ globals." },
        },
        required: ["script"],
        additionalProperties: false,
      },
      // Code Mode would let other code call it around the guard
      options: { codemode: false },
      execute: async (input, context) => {
        const session = sessionFor(context.sessionID);
        const agent = input.agent;
        if (agent !== undefined && !AGENT_NAME.test(agent)) {
          return { content: "The argument 'agent' must be a name of 1 to 40 letters, digits, -, _ or ." };
        }
        const scope = agentScope(session, agent);
        // a plain rejection of a question must end the step (opencode's permission.assert); the script then stops too
        const stop = { error: null };
        const result = await run(input.script, {
          root,
          globals: scope.globals,
          seen: scope.seen,
          undo: scope.undo,
          agent: agent || null,
          fetchHosts: session.fetchHosts,
          processes: session.processes,
          audit: session.audit,
          ask: askFor(ctx, context, stop, channel),
          harness: "opencode",
          maxSteps: MAX_STEPS,
          signal: context.signal,
          previousOutput: scope.output.text,
          session: session.name,
        });
        scope.output.text = keptOutput(result);
        if (stop.error !== null) {
          throw stop.error;
        }
        return { content: formatResult(result, input.script, root) };
      },
    });
  });

  // the guard, first wall: while ClankTalk is on, the model does not see the other tools
  await ctx.session.hook("context", async (event) => {
    // AGENTS.talk can change while opencode runs: read it again for each model request
    harness = await readHarness(root);
    if (!(await mode(event.sessionID)).on) {
      return;
    }
    for (const name of Object.keys(event.tools)) {
      if (!allowed(name)) {
        delete event.tools[name];
      }
    }
  });

  // the guard, second wall: a call that still comes is denied; ClankTalk's own questions always ask the human
  await ctx.permission.hook("evaluate", async (event) => {
    if (event.action === ASK_ACTION) {
      event.effect = "ask";
      return;
    }
    if (!allowed(event.action) && (await mode(event.sessionID)).on) {
      event.effect = "deny";
      event.message = "ClankTalk is on in this project, so " + event.action + " is blocked. Do the work in a ClankTalk script with the clank_talk tool. To allow it, the human can add a line to AGENTS.talk: allow harness tools " + event.action;
    }
  });

  // an allowed tool goes in the ClankTalk audit; an untrusted one's result taints; see src/md/features/harness-tools.md
  await ctx.tool.hook("execute.after", async (event) => {
    const name = event.tool;
    if (!event.sessionID || name === TOOL_NAME || BUILT_IN.includes(name) || !harnessToolAllowed(name, harness.allowed) || !(await mode(event.sessionID)).on) {
      return;
    }
    try {
      await recordHarnessTool(root, { session: sessionFor(event.sessionID).name, tool: name, input: event.input ?? null, output: resultText(event), untrusted: harnessToolAllowed(name, harness.untrusted || []) });
    } catch {
      // a failure to record never fails the tool
    }
  });

  return () => {
    for (const session of sessions.values()) {
      stopAllProcesses(session.processes);
    }
  };
}

// AGENTS.talk for the harness, and the tool's description; if AGENTS.talk cannot be read, ClankTalk stays on: fail closed
async function readHarness(root) {
  let harness;
  try {
    harness = await projectHarness(root);
  } catch (err) {
    harness = { agentsTalk: true, required: false, allowed: [], untrusted: [], errors: [err.message] };
  }
  harness.description = await describeTool(root);
  return harness;
}

// the text of a tool's result, for the record
function resultText(event) {
  const result = event.result;
  if (result === undefined || result === null) {
    return event.error ? String(event.error.message || event.error) : "";
  }
  if (typeof result === "string") {
    return result;
  }
  if (typeof result.content === "string") {
    return result.content;
  }
  if (Array.isArray(result.content)) {
    return result.content.map((part) => (part && typeof part.text === "string" ? part.text : "[" + (part && part.type) + "]")).join("\n");
  }
  return JSON.stringify(result);
}

// "ask" in a script, so the human answers, never the model
// first the TUI part, through the channel: a select dialog with the real choices; see channel.js
// if no TUI shows it within SEEN_WITHIN_MS (a web or desktop client), opencode's own permission prompt
export function askFor(ctx, context, stop = { error: null }, channel = null) {
  const permission = permissionAsk(ctx, context, stop);
  return async (request) => {
    if (request.fields) {
      return null;
    }
    if (channel !== null) {
      const answer = await askTui(channel, request, context.sessionID);
      if (answer !== undefined) {
        return answer;
      }
      if (request.signal && request.signal.aborted) {
        return null;
      }
    }
    return permission(request);
  };
}

// ask the TUI part: send the ask event, wait for seen, then for the answer; undefined when no TUI showed it
async function askTui(channel, { question, choices, many, signal }, sessionID) {
  const id = randomBytes(16).toString("hex");
  let markSeen;
  const seen = new Promise((resolve) => (markSeen = resolve));
  let giveAnswer;
  const answered = new Promise((resolve) => (giveAnswer = resolve));
  const STOPPED = Symbol("stopped");
  const stopped = new Promise((resolve) => (signal ? signal.addEventListener("abort", () => resolve(STOPPED), { once: true }) : undefined));
  let timer = null;
  channel.pending.set(id, { seen: () => markSeen(true), answer: giveAnswer });
  try {
    await channel.emit("ask", { id, question, choices: Array.isArray(choices) ? choices : [], many: Boolean(many), sessionID: String(sessionID || "") });
    const late = new Promise((resolve) => (timer = setTimeout(() => resolve(false), SEEN_WITHIN_MS)));
    const shown = await Promise.race([seen, late, stopped]);
    if (shown === STOPPED) {
      return null;
    }
    if (shown !== true) {
      return undefined;
    }
    const answer = await Promise.race([answered, stopped]);
    return answer === STOPPED ? null : answer;
  } catch {
    // the channel failed: use the permission prompt
    return undefined;
  } finally {
    clearTimeout(timer);
    channel.pending.delete(id);
  }
}

// opencode's own permission prompt: a yes or no question only; allow gives the first choice that starts with yes or approve, deny gives no
// other questions give null (no); a deny rule, or a rejection with feedback, is a Tool.Error: the answer is no
// a plain rejection is another error: it goes in stop.error, and the tool throws it after the script, to end the step
export function permissionAsk(ctx, context, stop = { error: null }) {
  return async ({ question, choices, fields, many, signal }) => {
    if (fields || many || !Array.isArray(choices) || choices.length === 0) {
      return null;
    }
    // a plain yes first: an allow must not approve untrusted inputs when a smaller yes is there
    const yes = choices.find((choice) => /^yes\b/i.test(choice)) || choices.find((choice) => /^approve\b/i.test(choice));
    const no = choices.find((choice) => /^no\b/i.test(choice));
    if (yes === undefined || no === undefined) {
      return null;
    }
    try {
      await ctx.permission.assert({
        sessionID: context.sessionID,
        agent: context.agent,
        source: { type: "tool", messageID: context.messageID, id: context.id },
        action: ASK_ACTION,
        resources: [question],
        metadata: { question, choices },
      });
      return signal && signal.aborted ? null : yes;
    } catch (err) {
      if (err && (err._tag === "Tool.Error" || err.name === "Tool.Error")) {
        return no;
      }
      stop.error = err;
      return null;
    }
  };
}

export default { id: "clank-talk", setup };