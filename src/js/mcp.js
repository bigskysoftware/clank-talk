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
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { run, listTools, VERSION } from "./clank-talk.js";

const TOOL_NAME = "clank_talk";

// the step budget for each call
const MAX_STEPS = 10_000;

// send progress this often while a script runs
const PROGRESS_EVERY_MS = 500;

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
  find 'text' in <file, files or text>   the result is the lines that contain it; print shows path:number: text

Git (hardened; the result is git's output as text):
  git status    git diff [<files>]    git log [<count>]    git show <commit>    git branches    git branch
  You cannot change .talk files, @/talk/, or hidden files and folders (.env, .git/), unless AGENTS.talk allows them.
  If a change is refused because of AGENTS.talk, tell the human the line to add. Do not try another way to make the change.

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
      result = await run(script, { root: session.root, globals: session.globals, seen: session.seen, maxSteps: MAX_STEPS, onStep });
    } finally {
      if (timer !== null) {
        clearInterval(timer);
      }
    }
    if (session.log) {
      await writeLog(session.log, script, result, session.root);
    }
    return reply(id, {
      content: [{ type: "text", text: formatResult(result, script, session.root) }],
      isError: result.status !== "done",
    });
  }

  return replyError(id, -32601, "Method not found: " + message.method);
}

// a log that humans can read: each script as written, then what happened
// the host writes it, not the script, so the sandbox does not apply
async function writeLog(file, script, result, root) {
  const time = new Date().toISOString().replace("T", " ").slice(0, 19);
  const entry = "\n=== " + time + "  " + result.status + "  " + result.steps + " steps ===\n" + script + "\n\n" + formatResult(result, script, root) + "\n";
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

  // notifications, such as progress, go out on stdout like responses
  session.send = (message) => {
    process.stdout.write(JSON.stringify(message) + "\n");
  };

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
