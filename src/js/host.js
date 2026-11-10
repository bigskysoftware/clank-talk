// what the hosts share: the tool description, the result text for the agent, and agent scopes
// the hosts are the MCP server (mcp.js) and the pi extension (pi-host.js)

import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { listTools } from "./clank-talk.js";
import { syntaxSummary } from "./help.js";
import { changedFiles } from "./diff.js";

// the step budget for each call
export const MAX_STEPS = 10_000;

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
export const SYNTAX = INTRO + "\n\n" + syntaxSummary() + "\n\n" + RULES;

// build the tool description: the syntax, then the tools from AGENTS.talk
export async function describeTool(root) {
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

// an agent name: letters, digits, -, _ and ., at most 40
export const AGENT_NAME = /^[A-Za-z0-9_.-]{1,40}$/;

// the per-agent part of a session: $ globals, the files it read (for the stale-write check), and its undo list
// with no name, the session's own; background processes, fetch approvals and the audit stay shared
export function agentScope(session, agent) {
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
