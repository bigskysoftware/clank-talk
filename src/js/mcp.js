// MCP host: lets an agent such as Claude Code run ClankTalk scripts
//
// MCP over stdio is JSON-RPC 2.0, one JSON message per line.
// This server answers only what it needs to:
//   initialize, ping, tools/list, tools/call
// It has one tool, "clank_talk", that runs a script.
//
// Logs go to stderr. stdout is only for protocol messages.

import { readFileSync, watch } from "node:fs";
import { createHash } from "node:crypto";
import nodePath from "node:path";
import { run, listTools, stopAllProcesses, VERSION } from "./clank-talk.js";
import { syntaxSummary } from "./help.js";
import { changedFiles } from "./diff.js";

const TOOL_NAME = "clank_talk";

// the step budget for each call
const MAX_STEPS = 10_000;

// send progress this often while a script runs
const PROGRESS_EVERY_MS = 500;

// three double quotes, for raw strings in the text below
const Q3 = '"'.repeat(3);

// the hand-written part of the tool description: what ClankTalk is, and what the summary cannot say
const INTRO = `Run a ClankTalk script. ClankTalk is a small, readable scripting language. Use it in place of a shell.
Each block ends with 'end'. A new line or 'then' separates commands. # starts a comment.
Strings: 'text' or "text", with \${} inside. ${Q3}raw${Q3} keeps the text exactly, with no escapes and no \${}: use it for code edits. A line break right after the opening ${Q3} is not part of the text. To hold ${Q3}, open and close with four quotes. To start the text with a quote, start it on the next line.
x's y, x.y and y of x are the same. 'the' is optional. it, or the result, is the value from the last command.`;

const RULES = `Rules:
  You cannot change .talk files, @/talk/, or hidden files and folders (.env, .git/), unless AGENTS.talk allows them.
  If a change is refused because of AGENTS.talk, tell the human the line to add. Do not try another way to make the change.
  A line edit (replace lines, put, remove) needs a read of the file first. Line numbers shift after an edit.
  ask goes to the human, never to you. null means no answer: treat it as no.
  Tools can run programs in an OS sandbox ('in a sandbox'). If a sandboxed program fails for a missing read, write or network, tell the human what the tool needs.

help lists everything. help <word> shows one command or expression, with examples: help replace. help recipes shows common tasks done well.
If you are one of several agents (a subagent), pass your name as 'agent' in each call, so your undo list and $ globals stay yours.`;

// the syntax summary comes from the help table, so it cannot drift from help
const SYNTAX = INTRO + "\n\n" + syntaxSummary() + "\n\n" + RULES;

// build the tool description: the syntax, then the tools from AGENTS.talk
async function describeTool(root) {
  let text = SYNTAX;
  const { tools, errors } = await listTools(root);
  if (tools.length > 0) {
    text += "\n\nTools from AGENTS.talk (call by name, arguments by position or with name: value):";
    for (const tool of tools) {
      if (tool.params.length > 0) {
        text += "\n  " + tool.name + " with " + tool.params.join(", ");
      } else {
        text += "\n  " + tool.name;
      }
      if (tool.description) {
        text += "    " + tool.description.split("\n")[0];
      }
    }
    text += "\n  Add 'within 5 minutes' to a call to set a time limit. A tool gives back the result, often { code, output }. A call is also a value: set tests to run_tests.";
  }
  if (errors.length > 0) {
    text += "\n\nAGENTS.talk has errors: " + errors.map((e) => e.message + " at " + e.line + ":" + e.column).join("; ");
  }
  return text;
}

// turn a run result into text for the agent
export function formatResult(result, script, root) {
  const sections = [];
  if (result.output.length > 0) {
    sections.push(result.output.join("\n"));
  }
  if (result.warnings && result.warnings.length > 0) {
    sections.push("--- warnings ---\n" + formatProblems(result.warnings, script, root));
  }
  if (result.errors.length > 0) {
    sections.push("--- " + result.status + " ---\n" + formatProblems(result.errors, script, root));
  }
  if (result.changes.length > 0) {
    sections.push("--- changed files ---\n" + changedFiles(result.changes));
  }
  if (sections.length === 0) {
    return "(no output)";
  }
  return sections.join("\n\n");
}

// errors or warnings: "file line:column message", then the source line with an arrow
// a problem in a .talk file has a file; the server reads that file from the root to show the line
function formatProblems(problems, script, root) {
  const lines = [];
  for (const p of problems) {
    const file = p.file ? p.file + " " : "";
    lines.push(file + p.line + ":" + p.column + " " + p.message);
    let source = script;
    if (p.file) {
      source = readTalkFile(root, p.file);
    }
    if (source !== undefined && source !== null) {
      const arrow = pointAt(source, p.line, p.column);
      if (arrow !== null) {
        lines.push(arrow);
      }
    }
  }
  return lines.join("\n");
}

// the text of a .talk file, for the line of an error in it; null if it cannot be read
// the name comes from the runtime, which loads .talk files only from inside the root
function readTalkFile(root, file) {
  try {
    return readFileSync(nodePath.resolve(root || ".", file), "utf8");
  } catch (err) {
    return null;
  }
}

// the source line of an error, with an arrow under the column:
//   5 | print t * 2
//     |         ^
function pointAt(source, line, column) {
  const lines = source.split("\n");
  if (line < 1 || line > lines.length) {
    return null;
  }
  const text = lines[line - 1].replace(/\r$/, "");
  const number = String(line);
  // keep tabs, so the arrow lines up under the same column
  const pad = text.slice(0, column - 1).replace(/[^\t]/g, " ");
  return "  " + number + " | " + text + "\n  " + " ".repeat(number.length) + " | " + pad + "^";
}

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
    if (agent !== undefined && (typeof agent !== "string" || !AGENT_NAME.test(agent))) {
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
      result = await run(script, { root: session.root, globals: scope.globals, seen: scope.seen, undo: scope.undo, agent: agent || null, policy: session.policy, fetchHosts: session.fetchHosts, processes: session.processes, audit: session.audit, ask: askFor(session), maxSteps: MAX_STEPS, onStep });
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

// an agent name: letters, digits, -, _ and ., at most 40
const AGENT_NAME = /^[A-Za-z0-9_.-]{1,40}$/;

// the per-agent part of a session: $ globals, the files it read (for the stale-write check), and its undo list
// with no name, the session's own; background processes, fetch approvals and the audit stay shared
function agentScope(session, agent) {
  if (agent === undefined) {
    return { globals: session.globals, seen: session.seen, undo: session.undo };
  }
  if (!session.agents) {
    session.agents = new Map();
  }
  if (!session.agents.has(agent)) {
    session.agents.set(agent, { globals: Object.create(null), seen: new Map(), undo: [] });
  }
  return session.agents.get(agent);
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
  if (index === -1) {
    return { policy: null };
  }
  const file = args[index + 1];
  if (!file) {
    return { error: "--policy needs a file" };
  }
  let source;
  try {
    source = readFileSync(nodePath.resolve(file), "utf8");
  } catch (err) {
    return { error: "cannot read the policy " + file + ": " + err.message };
  }
  const hashIndex = args.indexOf("--policy-hash");
  if (hashIndex !== -1) {
    const expected = (args[hashIndex + 1] || "").toLowerCase();
    const actual = createHash("sha256").update(source).digest("hex");
    if (expected !== actual) {
      return { error: "the policy " + file + " does not match --policy-hash. It was changed, so the server does not start" };
    }
  }
  return { policy: { name: nodePath.basename(file), source } };
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
  const session = { root, globals: Object.create(null), seen: new Map(), undo: [], fetchHosts: new Set(), processes: new Map(), audit: { scripts: 0, records: [] }, policy: policy.policy };

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
