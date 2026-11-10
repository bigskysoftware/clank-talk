// pi host: runs ClankTalk inside pi, as the only tool; see src/md/infrastructure/pi.md
// pi.js is the entry file. It gives this module pi's TypeBox, so the tests can run without pi.

import { run, stopAllProcesses } from "./clank-talk.js";
import { SYNTAX, formatResult, AGENT_NAME, agentScope, MAX_STEPS, keptOutput } from "./host.js";

const TOOL_NAME = "clank_talk";

// send progress at most this often while a script runs
const PROGRESS_EVERY_MS = 500;

/**
 * Set up the extension: the clank_talk tool, and a guard that blocks every other tool.
 * @param {Object} pi    pi's ExtensionAPI
 * @param {Object} Type  TypeBox's Type, for the tool parameters
 */
export function clankTalkExtension(pi, Type) {
  // one session, as in the MCP server: $ globals, reads, undo, fetch approvals, processes and the audit
  let session = null;

  pi.on("session_start", async (_event, ctx) => {
    session = newSession(ctx.cwd);
    // ClankTalk is the only tool the model sees
    pi.setActiveTools([TOOL_NAME]);
  });

  pi.on("session_shutdown", async () => {
    if (session !== null) {
      stopAllProcesses(session.processes);
    }
  });

  // block every other tool: built-in tools, MCP tools, and calls from codemode
  pi.on("tool_call", async (event) => {
    if (event.toolName !== TOOL_NAME) {
      return { block: true, reason: "Only clank_talk is allowed here. Do the work in a ClankTalk script." };
    }
    return undefined;
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "ClankTalk",
    description: SYNTAX + "\n\nhelp tools lists the tools from AGENTS.talk.",
    parameters: Type.Object({
      script: Type.String({ description: "The ClankTalk script to run" }),
      agent: Type.Optional(Type.String({ description: "Your name, if you are one of several agents, such as 'tester'. Each name has its own undo list and $ globals." })),
    }),
    // calls share the globals, the undo list and the reads, so they run one at a time
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (session === null) {
        session = newSession(ctx.cwd);
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
        policy: null,
        fetchHosts: session.fetchHosts,
        processes: session.processes,
        audit: session.audit,
        ask: askFor(ctx),
        maxSteps: MAX_STEPS,
        onStep: progressFor(onUpdate),
        signal,
        previousOutput: scope.output.text,
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

function newSession(root) {
  return { root, globals: Object.create(null), seen: new Map(), undo: [], fetchHosts: new Set(), processes: new Map(), audit: { scripts: 0, records: [] } };
}

// "ask" in a script goes to a pi dialog, so the human answers, never the model
// with no UI (print and JSON modes), there is no ask, so the answer is null: no
function askFor(ctx) {
  if (!ctx || !ctx.hasUI) {
    return null;
  }
  return async ({ question, choices, signal }) => {
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
