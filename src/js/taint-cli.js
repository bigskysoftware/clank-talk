// The human's side of session taint: npx clank-talk taint ... ; see src/md/features/taint.md
// The agent cannot run this: it has no shell in ClankTalk, and scripts cannot change .talk/.

import fs from "node:fs/promises";
import nodePath from "node:path";
import { parse } from "./parser.js";
import * as untrusted from "./untrusted.js";

export const USAGE = `Usage: clank-talk taint [command] [--root <dir>]

  clank-talk taint                     list the untrusted inputs, with their source and status
  clank-talk taint show <ref>          show one input: source, time and text
  clank-talk taint approve <ref> ...   approve inputs
  clank-talk taint approve --all       approve all inputs: clears all taints
  clank-talk taint approve --clean     approve the inputs that the judge found clean
  clank-talk taint on | off            turn session taint on or off for this project

A <ref> is <session>/<n>, such as claude-code-4f2a/3, or <n> for the newest session.`;

// the "taint" line of AGENTS.talk: "on", "off", "required", or null
async function agentsTaintLine(root) {
  let source;
  try {
    source = await fs.readFile(nodePath.join(root, "AGENTS.talk"), "utf8");
  } catch (err) {
    return null;
  }
  try {
    const { script } = parse(source, { definitions: true });
    const line = (script && script.definitions ? script.definitions : []).find((definition) => definition.type === "taint");
    return line === undefined ? null : line.mode;
  } catch (err) {
    return null;
  }
}

function sizeText(bytes) {
  if (bytes < 1024) {
    return bytes + " B";
  }
  return bytes >= 1024 * 1024 ? Math.ceil(bytes / (1024 * 1024)) + " MB" : Math.ceil(bytes / 1024) + " KB";
}

function statusText(entry) {
  return entry.approved ? "approved" : "new";
}

function judgeText(entry) {
  if (!entry.verdict) {
    return "-";
  }
  return entry.verdict.reason ? entry.verdict.result + ": " + entry.verdict.reason : entry.verdict.result;
}

// all inputs: [{ session, entry }], oldest session first
async function allInputs(root) {
  const found = [];
  for (const session of await untrusted.sessions(root)) {
    for (const entry of await untrusted.inputs(root, session)) {
      found.push({ session, entry });
    }
  }
  return found;
}

// <session>/<n>, or <n> for the newest session
async function findRef(root, ref) {
  const sessions = await untrusted.sessions(root);
  const slash = ref.lastIndexOf("/");
  const session = slash === -1 ? sessions[sessions.length - 1] : ref.slice(0, slash);
  const n = Number(slash === -1 ? ref : ref.slice(slash + 1));
  if (session === undefined || !Number.isInteger(n)) {
    return null;
  }
  const entry = (await untrusted.inputs(root, session)).find((item) => item.n === n);
  return entry === undefined ? null : { session, entry };
}

// runs one taint command; out takes lines of text; gives the exit code
export async function taintCommand(args, root, out) {
  const [command = "list", ...rest] = args;
  const agentsLine = await agentsTaintLine(root);

  if (command === "list") {
    const commandLine = await untrusted.commandLineMode(root);
    let state;
    if (agentsLine === "required") {
      state = "on (required by AGENTS.talk)";
    } else if (commandLine !== null) {
      state = commandLine + " (from the command line)";
    } else {
      state = (agentsLine || "on") + (agentsLine === null ? " (the default)" : " (from AGENTS.talk)");
    }
    out("taint: " + state);
    const inputs = await allInputs(root);
    if (inputs.length === 0) {
      out("No untrusted inputs.");
      return 0;
    }
    out("");
    // columns: ref, time, status, size, judge, source; the source is last, as it can be long
    const rows = [["ref", "time", "status", "size", "judge", "source"]];
    for (const { session, entry } of inputs) {
      rows.push([session + "/" + entry.n, entry.time, statusText(entry), sizeText(entry.size) + (entry.cut ? " (cut)" : ""), judgeText(entry), entry.source]);
    }
    const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
    for (const row of rows) {
      out(row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]))).join("  "));
    }
    const waiting = inputs.filter(({ entry }) => !entry.approved).length;
    out("");
    out(waiting + " not approved. Show one with: npx clank-talk taint show <ref>");
    return 0;
  }

  if (command === "show") {
    const found = rest.length === 1 ? await findRef(root, rest[0]) : null;
    if (found === null) {
      out("No untrusted input " + (rest[0] || "") + ". List them with: npx clank-talk taint");
      return 1;
    }
    out("status: " + statusText(found.entry) + (found.entry.approvedBy ? " by " + found.entry.approvedBy : ""));
    out("judge: " + judgeText(found.entry));
    out(await untrusted.inputText(root, found.session, found.entry));
    return 0;
  }

  if (command === "approve") {
    if (rest.length === 0) {
      out("Name the inputs to approve, or use --all or --clean.\n\n" + USAGE);
      return 1;
    }
    const picked = [];
    if (rest.includes("--all") || rest.includes("--clean")) {
      const clean = rest.includes("--clean") && !rest.includes("--all");
      for (const item of await allInputs(root)) {
        if (!clean || (item.entry.verdict && item.entry.verdict.result === "clean")) {
          picked.push(item);
        }
      }
    } else {
      for (const ref of rest) {
        const found = await findRef(root, ref);
        if (found === null) {
          out("No untrusted input " + ref + ". Nothing was approved.");
          return 1;
        }
        picked.push(found);
      }
    }
    const bySession = new Map();
    for (const { session, entry } of picked) {
      bySession.set(session, [...(bySession.get(session) || []), entry.n]);
    }
    let count = 0;
    for (const [session, numbers] of bySession) {
      count += (await untrusted.approve(root, session, numbers, "the command line")).length;
    }
    out("Approved " + count + (count === 1 ? " input." : " inputs."));
    return 0;
  }

  if (command === "on" || command === "off") {
    if (command === "off" && agentsLine === "required") {
      out("AGENTS.talk has 'taint required'. To turn taint off, remove that line.");
      return 1;
    }
    await untrusted.setCommandLineMode(root, command);
    out("taint: " + command + " (from the command line)");
    return 0;
  }

  out("Unknown taint command: " + command + "\n\n" + USAGE);
  return 1;
}
