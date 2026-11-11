// The human's side of session taint: npx clank-talk taint ... ; see src/md/features/taint.md
// The agent cannot run this: it has no shell in ClankTalk, and scripts cannot change .talk/.

import fs from "node:fs/promises";
import nodePath from "node:path";
import { parse } from "./parser.js";
import * as untrusted from "./untrusted.js";
import { projectJudge } from "./runtime.js";
import { runTui } from "./taint-tui.js";

export const USAGE = `Usage: clank-talk taint [command] [--root <dir>]

  clank-talk taint                     list the untrusted inputs, with their source and status
  clank-talk taint show <ref>          show one input: source, time and text
  clank-talk taint approve <ref> ...   approve inputs
  clank-talk taint approve --all       approve all inputs: clears all taints
  clank-talk taint approve --clean     approve the inputs that the judge found clean
  clank-talk taint unapprove <ref> ... take back approvals: the inputs taint the session again
  clank-talk taint judge <ref> ...     the judge reads inputs, and gives clean, suspect or unsure
  clank-talk taint judge --all         the judge reads the inputs that it did not read and that are not approved
  clank-talk taint on | off            turn session taint on or off for this project
  clank-talk taint --tui               a full-screen review: read, mark and approve inputs (q to quit)
  clank-talk taint --line              one short line for a status bar: taint off, untainted, or tainted <n> (inputs to review)

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
// options.lendModel: for tests, a model in place of the one in AGENTS.talk
// options.input, options.output: for tests, the terminal for --tui
export async function taintCommand(args, root, out, options = {}) {
  const [command = "list", ...rest] = args;
  const agentsLine = await agentsTaintLine(root);

  // a policy that requires taint leaves a note in .talk/, because the command line cannot see the policy
  const policy = await untrusted.policyRequires(root);

  const commandLine = await untrusted.commandLineMode(root);
  // the state and where it comes from: ["on", "the default"]
  let state;
  if (policy !== null) {
    state = ["required", "required by the policy " + untrusted.printable(policy)];
  } else if (agentsLine === "required") {
    state = ["required", "required by AGENTS.talk"];
  } else if (commandLine !== null) {
    state = [commandLine, "from the command line"];
  } else {
    state = [agentsLine || "on", agentsLine === null ? "the default" : "from AGENTS.talk"];
  }

  // for a status bar: taint off, untainted, or tainted <n> with n inputs to review
  if (command === "--line") {
    const waiting = (await allInputs(root)).filter(({ entry }) => !entry.approved).length;
    out(state[0] === "off" ? "taint off" : waiting === 0 ? "untainted" : "tainted " + waiting);
    return 0;
  }

  if (command === "--tui") {
    return await runTui(root, options.input || process.stdin, options.output || process.stdout, out, options);
  }

  if (command === "list") {
    out("taint: " + (state[0] === "required" ? "on" : state[0]) + " (" + state[1] + ")");
    const inputs = await allInputs(root);
    if (inputs.length === 0) {
      out("No untrusted inputs.");
      return 0;
    }
    out("");
    // columns: ref, time, status, size, judge, source; the source is last, as it can be long
    const rows = [["ref", "time", "status", "size", "judge", "source"]];
    for (const { session, entry } of inputs) {
      rows.push([session + "/" + entry.n, entry.time, statusText(entry), sizeText(entry.size) + (entry.cut ? " (cut)" : ""), untrusted.printable(judgeText(entry)), untrusted.printable(entry.source)]);
    }
    for (const line of untrusted.table(rows)) {
      out(line);
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
    out("judge: " + untrusted.printable(judgeText(found.entry)));
    // the text is untrusted: control characters can hide text or move the cursor, so they show as ?
    out(untrusted.printable(await untrusted.inputText(root, found.session, found.entry), true));
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

  if (command === "unapprove") {
    if (rest.length === 0) {
      out("Name the inputs to unapprove.\n\n" + USAGE);
      return 1;
    }
    const picked = [];
    for (const ref of rest) {
      const found = await findRef(root, ref);
      if (found === null) {
        out("No untrusted input " + ref + ". Nothing was unapproved.");
        return 1;
      }
      picked.push(found);
    }
    let count = 0;
    for (const { session, entry } of picked) {
      count += (await untrusted.unapprove(root, session, [entry.n])).length;
    }
    out("Unapproved " + count + (count === 1 ? " input." : " inputs."));
    return 0;
  }

  if (command === "judge") {
    if (rest.length === 0) {
      out("Name the inputs to judge, or use --all.\n\n" + USAGE);
      return 1;
    }
    const picked = [];
    if (rest.includes("--all")) {
      for (const item of await allInputs(root)) {
        if (!item.entry.verdict && !item.entry.approved) {
          picked.push(item);
        }
      }
    } else {
      for (const ref of rest) {
        const found = await findRef(root, ref);
        if (found === null) {
          out("No untrusted input " + ref + ". Nothing was judged.");
          return 1;
        }
        picked.push(found);
      }
    }
    if (picked.length === 0) {
      out("No inputs to judge.");
      return 0;
    }
    const setup = await projectJudge(root, options);
    if (setup.error) {
      out(setup.error);
      return 1;
    }
    for (const { session, entry } of picked) {
      const text = await untrusted.inputText(root, session, entry);
      let verdict;
      try {
        // the text starts after the header lines (source, time, cut) and one blank line
        verdict = await setup.judge(entry.source, text.slice(text.indexOf("\n\n") + 2));
      } catch (err) {
        out(session + "/" + entry.n + "  the judge failed: " + untrusted.printable(err.message));
        continue;
      }
      const approved = await untrusted.setVerdict(root, session, entry.n, verdict, setup.approves);
      out(session + "/" + entry.n + "  " + verdict.result + (verdict.reason ? ": " + untrusted.printable(verdict.reason) : "") + (approved ? "  (approved by the judge)" : ""));
    }
    return 0;
  }

  if (command === "on" || command === "off") {
    if (command === "off" && policy !== null) {
      out("The policy " + untrusted.printable(policy) + " has 'taint required', so taint stays on.");
      return 1;
    }
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
