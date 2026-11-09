// MCP host: lets an agent such as Claude Code run ClankTalk scripts
//
// MCP over stdio is JSON-RPC 2.0, one JSON message per line.
// This server answers only what it needs to:
//   initialize, ping, tools/list, tools/call
// It has one tool, "clank_talk", that runs a script.
//
// Logs go to stderr. stdout is only for protocol messages.

import readline from "node:readline";
import fs from "node:fs/promises";
import nodePath from "node:path";
import { run, listTools, VERSION } from "./clank-talk.js";

const TOOL_NAME = "clank_talk";

const SYNTAX = `Run a ClankTalk script. ClankTalk is a small, readable scripting language. Use it in place of a shell.

Basics:
  print <value>                         output to you
  set x to <value>     increment x [by n]     decrement x [by n]
  if <condition> ... end
  for item in <list> [index i] ... end
  repeat 3 times ... end    repeat while <condition> ... end    repeat until <condition> ... end
  break    continue    then (separates commands on one line)
  on error ... end   anywhere in a script or tool; the error's message; continue goes on after the failed command, stop (the default) ends with the error
  # a comment

Values: 'text', "text", 'Hi \${name}' (\\\${ for a plain \${), 12, 3.5, true, false, null, [1, 2], {a: 1}
  Strings can span lines. Common indent is removed.
  """raw text""": no escapes, no \${}, and the indent is kept exactly. Use it for code edits.
  x's y, x.y and y of x are the same: lines of the result's output.  "the" is optional: the file's text
  it / the result: the value from the last command
  $name: a global that stays between calls

Operators: + - * / mod (mixing needs parentheses), is, is not, < > <= >=, is less than ...,
  contains, does not contain, starts with, ends with, is in, exists, is empty, and, or, not, no,
  as json, as pretty json, as number, as text

Files (paths: ./x and ../x from the current folder, @/x from the project root):
  ./src/**/*.js gives a list of files. A file has name, path, text, lines, first, last, size, modified.
  A line has number and text. Text has lines too. first of and last of: a list's items, or the lines of a file or text. Text operators work on files and lines.
  lines 10 to 20 of <file or text>: a range by line number. print shows each line with its number.
  replace lines 5 to 7 of <file> with <text>    put <text> before|after line 5 of <file>    remove lines 5 to 7 of <file>
  A line edit needs a read of the file first. The result is the old lines. Line numbers shift after an edit.
  read <file>          set x to read <file>
  write <value> to <file>      append <value> to <file>
  replace 'old' with 'new' in <file or variable>   the result lists each replacement
  You cannot change .talk files or @/talk/.

help lists everything. help <word> shows one command, expression or tool, with examples: help replace`;

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
    text += "\n  Add 'within 5 minutes' to a call to set a time limit. A tool gives back the result, often { code, output }.";
  }
  if (errors.length > 0) {
    text += "\n\nAGENTS.talk has errors: " + errors.map((e) => e.message + " at " + e.line + ":" + e.column).join("; ");
  }
  return text;
}

// turn a run result into text for the agent
export function formatResult(result) {
  const sections = [];
  if (result.output.length > 0) {
    sections.push(result.output.join("\n"));
  }
  if (result.errors.length > 0) {
    const lines = [];
    for (const e of result.errors) {
      const file = e.file ? e.file + " " : "";
      lines.push(file + e.line + ":" + e.column + " " + e.message);
    }
    sections.push("--- " + result.status + " ---\n" + lines.join("\n"));
  }
  if (result.changes.length > 0) {
    const paths = [];
    for (const change of result.changes) {
      paths.push(change.path);
    }
    sections.push("--- changed files ---\n" + paths.join("\n"));
  }
  if (sections.length === 0) {
    return "(no output)";
  }
  return sections.join("\n\n");
}

/**
 * Answer one JSON-RPC message. Gives the response, or null for a notification.
 * @param {Object} message
 * @param {{ root: string, globals: Object }} session
 */
export async function handleMessage(message, session) {
  // a notification has no id, and gets no answer
  if (message.id === undefined || message.id === null) {
    return null;
  }

  const id = message.id;
  const params = message.params || {};

  if (message.method === "initialize") {
    return reply(id, {
      // answer with the version the client asks for
      protocolVersion: params.protocolVersion || "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "clank-talk", version: VERSION },
    });
  }

  if (message.method === "ping") {
    return reply(id, {});
  }

  if (message.method === "tools/list") {
    return reply(id, {
      tools: [
        {
          name: TOOL_NAME,
          description: await describeTool(session.root),
          inputSchema: {
            type: "object",
            properties: { script: { type: "string", description: "The ClankTalk script to run" } },
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
    const result = await run(script, { root: session.root, globals: session.globals, seen: session.seen });
    if (session.log) {
      await writeLog(session.log, script, result);
    }
    return reply(id, {
      content: [{ type: "text", text: formatResult(result) }],
      isError: result.status !== "done",
    });
  }

  return replyError(id, -32601, "Method not found: " + message.method);
}

// a log that humans can read: each script as written, then what happened
// the host writes it, not the script, so the sandbox does not apply
async function writeLog(file, script, result) {
  const time = new Date().toISOString().replace("T", " ").slice(0, 19);
  const entry = "\n=== " + time + "  " + result.status + "  " + result.steps + " steps ===\n" + script + "\n\n" + formatResult(result) + "\n";
  await fs.mkdir(nodePath.dirname(file), { recursive: true });
  await fs.appendFile(file, entry);
}

function reply(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function replyError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * Start the server on stdin and stdout.
 * @param {string[]} args  command line arguments: [--root <dir>]
 */
export function main(args) {
  let root = process.cwd();
  const rootIndex = args.indexOf("--root");
  if (rootIndex !== -1 && args[rootIndex + 1]) {
    root = args[rootIndex + 1];
  }

// --log <file>: append a readable log of each run
let log = null;
const logIndex = args.indexOf("--log");
if (logIndex !== -1 && args[logIndex + 1]) {
  log = nodePath.resolve(args[logIndex + 1]);
}

// one session for the life of the server, so $ globals stay between calls
const session = { root, globals: Object.create(null), seen: new Map(), log };

  const input = readline.createInterface({ input: process.stdin });
  input.on("line", async (line) => {
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
  });
}
