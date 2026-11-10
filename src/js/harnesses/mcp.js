// MCP host: lets an agent such as Claude Code run ClankTalk scripts
//
// MCP over stdio is JSON-RPC 2.0, one JSON message per line.
// This server answers only what it needs to:
//   initialize, ping, tools/list, tools/call
// It has one tool, "clank_talk", that runs a script.
//
// Logs go to stderr. stdout is only for protocol messages.

import { watch } from "node:fs";
import { run, stopAllProcesses, VERSION } from "../clank-talk.js";
import { describeTool, formatResult, AGENT_NAME, agentScope, MAX_STEPS, keptOutput, sessionName, loadPolicy } from "../host.js";

const TOOL_NAME = "clank_talk";

// send progress this often while a script runs
const PROGRESS_EVERY_MS = 500;

/**
 * Answer one JSON-RPC message. Gives the response, or null for a notification.
 * @param {Object} message
 * @param {{ root: string, globals: Object }} session
 */
export async function handleMessage(message, session) {
  // an answer to a request from this server, such as elicitation/create
  if (message.method === undefined && message.id !== undefined && message.id !== null) {
    answerRequest(message, session);
    return null;
  }

  // a notification has no id, and gets no answer
  if (message.id === undefined || message.id === null) {
    return null;
  }

  const id = message.id;
  const params = message.params || {};

  if (message.method === "initialize") {
    // a client that supports elicitation can show a question to the human: see "ask"
    session.canAsk = Boolean(params.capabilities && params.capabilities.elicitation);
    // the audit names the session after the client, such as claude-code-4f2a
    session.name = sessionName(params.clientInfo && params.clientInfo.name);
    return reply(id, {
      // answer with the version the client asks for
      protocolVersion: params.protocolVersion || "2025-06-18",
      // listChanged: the server tells the client when AGENTS.talk changes the tools
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "clank-talk", version: VERSION },
    });
  }

  if (message.method === "ping") {
    return reply(id, {});
  }

  if (message.method === "tools/list") {
    // remember what the client saw, so a change to AGENTS.talk can be noticed
    session.toolsDescription = await describeTool(session.root);
    return reply(id, {
      tools: [
        {
          name: TOOL_NAME,
          description: session.toolsDescription,
          inputSchema: {
            type: "object",
            properties: {
              script: { type: "string", description: "The ClankTalk script to run" },
              agent: { type: "string", description: "Your name, if you are one of several agents, such as 'tester'. Each name has its own undo list and $ globals." },
            },
            required: ["script"],
          },
        },
      ],
    });
  }

  if (message.method === "tools/call") {
    if (params.name !== TOOL_NAME) {
      return replyError(id, -32602, "Unknown tool: " + params.name);
    }
    const script = params.arguments && params.arguments.script;
    if (typeof script !== "string") {
      return replyError(id, -32602, "The argument 'script' must be text");
    }
    // agent: a subagent's name; each name has its own undo list, $ globals and reads
    const agent = params.arguments.agent;
    // null counts as no agent, as a missing field does
    if (agent !== undefined && agent !== null && (typeof agent !== "string" || !AGENT_NAME.test(agent))) {
      return replyError(id, -32602, "The argument 'agent' must be a name of 1 to 40 letters, digits, -, _ or .");
    }
    const scope = agentScope(session, agent);
    // the client asks for progress with a token
    // a timer sends where the script is, also while a slow tool runs
    // no total: the step budget says nothing about how long a script takes
    let onStep = null;
    let timer = null;
    const token = params._meta && params._meta.progressToken;
    if (token !== undefined && session.send) {
      const started = Date.now();
      let current = null;
      let count = 0;
      onStep = (step) => {
        current = step;
      };
      timer = setInterval(() => {
        if (current === null) {
          return;
        }
        // progress must grow with each notification, so it counts them
        count++;
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        const message = "line " + current.line + ": " + current.type + " (step " + current.steps + ", " + seconds + "s)";
        session.send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: count, message } });
      }, session.progressEveryMs || PROGRESS_EVERY_MS);
    }
    let result;
    try {
      result = await run(script, { root: session.root, globals: scope.globals, seen: scope.seen, undo: scope.undo, agent: agent || null, policy: session.policy, fetchHosts: session.fetchHosts, privateHosts: session.privateHosts, harness: "MCP", processes: session.processes, audit: session.audit, ask: askFor(session), maxSteps: MAX_STEPS, onStep, previousOutput: scope.output.text, previousOutputLabels: scope.output.labels, session: session.name || (session.name = sessionName(null)) });
      scope.output.text = keptOutput(result);
      scope.output.labels = result.outputLabels || null;
    } finally {
      if (timer !== null) {
        clearInterval(timer);
      }
    }
    return reply(id, {
      content: [{ type: "text", text: formatResult(result, script, session.root) }],
      isError: result.status !== "done",
    });
  }

  return replyError(id, -32601, "Method not found: " + message.method);
}

// send a request to the client, and wait for its answer: the whole message, or null if cancelled
// the answer comes back through handleMessage, as a message with the same id and no method
let nextRequestId = 1;
function requestClient(session, method, params, signal) {
  if (!session.pending) {
    session.pending = new Map();
  }
  const id = "clank-talk-" + nextRequestId;
  nextRequestId++;
  return new Promise((resolve) => {
    session.pending.set(id, resolve);
    if (signal) {
      signal.addEventListener("abort", () => {
        session.pending.delete(id);
        resolve(null);
      });
    }
    session.send({ jsonrpc: "2.0", id, method, params });
  });
}

function answerRequest(message, session) {
  if (!session.pending || !session.pending.has(message.id)) {
    return;
  }
  const resolve = session.pending.get(message.id);
  session.pending.delete(message.id);
  resolve(message);
}

// "ask" in a script: an MCP elicitation, so the human answers in the client, never the agent
// the answer is text, or null if the human declines or cancels
function askFor(session) {
  if (!session.canAsk || !session.send) {
    return null;
  }
  return async ({ question, choices, signal }) => {
    const answer = { type: "string", title: "Answer" };
    if (choices.length > 0) {
      answer.enum = choices;
    }
    const requestedSchema = { type: "object", properties: { answer }, required: ["answer"] };
    const response = await requestClient(session, "elicitation/create", { message: question, requestedSchema }, signal);
    if (response === null || !response.result || response.result.action !== "accept") {
      return null;
    }
    const content = response.result.content || {};
    if (typeof content.answer !== "string") {
      return null;
    }
    return content.answer;
  };
}

// a .talk file changed: if the tool description changed too, tell the client to list the tools again
// only after the client listed them once; gives true if it sent the notification
export async function toolsChanged(session) {
  if (session.toolsDescription === undefined || !session.send) {
    return false;
  }
  const description = await describeTool(session.root);
  if (description === session.toolsDescription) {
    return false;
  }
  session.toolsDescription = description;
  session.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  return true;
}

// watch the project for changes to .talk files; the audit folder is not a .talk file
function watchTalkFiles(session) {
  let timer = null;
  try {
    watch(session.root, { recursive: true }, (event, name) => {
      if (!name || !String(name).endsWith(".talk")) {
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        toolsChanged(session).catch((err) => process.stderr.write("clank-talk: " + err.message + "\n"));
      }, 200);
    });
  } catch (err) {
    process.stderr.write("clank-talk: cannot watch .talk files, so a change to AGENTS.talk needs a reconnect: " + err.message + "\n");
  }
}

function reply(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function replyError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// read the policy file named by --policy, and check it against --policy-hash if given
// gives { policy: { name, source } or null } or { error }; a changed policy file stops the server
export function readPolicy(args) {
  const index = args.indexOf("--policy");
  const hashIndex = args.indexOf("--policy-hash");
  const file = index === -1 ? null : args[index + 1];
  const hash = hashIndex === -1 ? null : args[hashIndex + 1] || "";
  return loadPolicy(file, hash, { file: "--policy", hash: "--policy-hash", stops: "the server does not start" });
}

/**
 * Start the server on stdin and stdout.
 * @param {string[]} args  command line arguments: [--root <dir>] [--policy <file> [--policy-hash <sha256>]]
 */
export function main(args) {
  let root = process.cwd();
  const rootIndex = args.indexOf("--root");
  if (rootIndex !== -1 && args[rootIndex + 1]) {
    root = args[rootIndex + 1];
  }

  // --policy <file> [--policy-hash <sha256>]: the harness's policy for this session; see src/md/features/policy.md
  const policy = readPolicy(args);
  if (policy.error) {
    process.stderr.write("clank-talk: " + policy.error + "\n");
    process.exit(1);
  }

  // one session for the life of the server, so $ globals stay between calls
  const session = { root, globals: Object.create(null), seen: new Map(), undo: [], fetchHosts: new Set(), privateHosts: new Set(), processes: new Map(), audit: { scripts: 0, records: [] }, policy: policy.policy };

  // when the client goes away, stop the background processes, so nothing is left running
  const stopAll = () => stopAllProcesses(session.processes);
  process.on("exit", stopAll);
  process.stdin.on("end", () => {
    stopAll();
    process.exit(0);
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      stopAll();
      process.exit(0);
    });
  }

  // notifications, such as progress, go out on stdout like responses
  session.send = (message) => {
    process.stdout.write(JSON.stringify(message) + "\n");
  };
  watchTalkFiles(session);

  // one message on each line; split on \n only: readline also splits on U+2028 and U+2029,
  // which JSON allows in a string, and then the request gets no answer
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      handleLine(buffer.slice(0, index), session);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
  });
}

// one line from stdin: a JSON-RPC message; the answer, if any, goes to stdout
async function handleLine(line, session) {
  if (line.trim() === "") {
    return;
  }
  let message;
  try {
    message = JSON.parse(line);
  } catch (err) {
    process.stdout.write(JSON.stringify(replyError(null, -32700, "Parse error")) + "\n");
    return;
  }
  // JSON-RPC needs an object; null, a number or a list is an invalid request
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    process.stdout.write(JSON.stringify(replyError(null, -32600, "Invalid Request")) + "\n");
    return;
  }
  try {
    const response = await handleMessage(message, session);
    if (response !== null) {
      process.stdout.write(JSON.stringify(response) + "\n");
    }
  } catch (err) {
    process.stderr.write("clank-talk: " + err.stack + "\n");
    if (message.id !== undefined && message.id !== null) {
      process.stdout.write(JSON.stringify(replyError(message.id, -32603, err.message)) + "\n");
    }
  }
}
