// Session taint: the untrusted inputs that a session saw, kept for the human. See src/md/features/taint.md
//
// After the agent sees untrusted text (fetch, an untrusted tool, a subagent), the session is untrusted
// until the human approves each input. Each input is saved in @/.talk/untrusted/<session>/:
//   index.json   [{ n, time, source, size, cut, file, approved }]
//   <n>.txt      the source, the time, and the text
// Scripts cannot change @/.talk/, so the agent cannot change or remove what it read.

import fs from "node:fs/promises";
import nodePath from "node:path";

export const STORE = ".talk/untrusted";
// the command line keeps "taint on" or "taint off" here; see taintMode
export const STATE_FILE = ".talk/taint-state.json";
// the size that an input keeps, by default; "keep untrusted inputs up to 5 MB" changes it
export const DEFAULT_KEEP_BYTES = 1024 * 1024;

// a session name as a folder name
function folderName(session) {
  return String(session || "default").replace(/[^A-Za-z0-9._-]/g, "-");
}

export function folder(root, session) {
  return nodePath.join(root, STORE, folderName(session));
}

// the folder as the human sees it: .talk/untrusted/<session>/
export function storePath(session) {
  return STORE + "/" + folderName(session) + "/";
}

// the local date and time: 2026-11-10 17:40:41
export function localTime(date = new Date()) {
  const two = (value) => String(value).padStart(2, "0");
  return date.getFullYear() + "-" + two(date.getMonth() + 1) + "-" + two(date.getDate()) + " " + two(date.getHours()) + ":" + two(date.getMinutes()) + ":" + two(date.getSeconds());
}

// the inputs of a session; a missing or broken index is empty
export async function inputs(root, session) {
  try {
    const entries = JSON.parse(await fs.readFile(nodePath.join(folder(root, session), "index.json"), "utf8"));
    return Array.isArray(entries) ? entries : [];
  } catch (err) {
    return [];
  }
}

// the sessions in the store, by folder name, oldest first
export async function sessions(root) {
  let names;
  try {
    names = await fs.readdir(nodePath.join(root, STORE));
  } catch (err) {
    return [];
  }
  const found = [];
  for (const name of names) {
    const entries = await inputs(root, name);
    if (entries.length > 0) {
      found.push({ name, first: entries[0].time });
    }
  }
  return found.sort((a, b) => a.first.localeCompare(b.first)).map((session) => session.name);
}

async function save(root, session, entries) {
  await fs.mkdir(folder(root, session), { recursive: true });
  await fs.writeFile(nodePath.join(folder(root, session), "index.json"), JSON.stringify(entries, null, 2) + "\n");
}

// save one input; gives its entry
export async function record(root, session, { source, text, time, keepBytes }) {
  const entries = await inputs(root, session);
  const n = entries.length === 0 ? 1 : entries[entries.length - 1].n + 1;
  const bytes = Buffer.from(text, "utf8");
  const cut = bytes.length > keepBytes;
  const kept = cut ? bytes.subarray(0, keepBytes).toString("utf8") : text;
  const file = n + ".txt";
  await fs.mkdir(folder(root, session), { recursive: true });
  await fs.writeFile(nodePath.join(folder(root, session), file), "source: " + source + "\ntime: " + time + (cut ? "\ncut: kept the first " + keepBytes + " of " + bytes.length + " bytes" : "") + "\n\n" + kept);
  const entry = { n, time, source, size: bytes.length, cut, file, approved: false };
  entries.push(entry);
  await save(root, session, entries);
  return entry;
}

// the inputs that are not approved
export function pending(entries) {
  return entries.filter((entry) => !entry.approved);
}

// approve the inputs with these numbers; gives the numbers that changed
// by says who approved: "the question" or "the command line"
export async function approve(root, session, numbers, by = "the question") {
  const entries = await inputs(root, session);
  const changed = [];
  for (const entry of entries) {
    if (numbers.includes(entry.n) && !entry.approved) {
      entry.approved = true;
      entry.approvedBy = by;
      entry.approvedAt = new Date().toISOString();
      changed.push(entry.n);
    }
  }
  if (changed.length > 0) {
    await save(root, session, entries);
  }
  return changed;
}

// the text file of an input
export async function inputText(root, session, entry) {
  return await fs.readFile(nodePath.join(folder(root, session), entry.file), "utf8");
}

// "taint on" or "taint off" from the command line
export async function setCommandLineMode(root, mode) {
  await fs.mkdir(nodePath.join(root, ".talk"), { recursive: true });
  await fs.writeFile(nodePath.join(root, STATE_FILE), JSON.stringify({ taint: mode }) + "\n");
}

// "on" or "off" from the command line, or null
export async function commandLineMode(root) {
  try {
    const state = JSON.parse(await fs.readFile(nodePath.join(root, STATE_FILE), "utf8"));
    return state.taint === "on" || state.taint === "off" ? state.taint : null;
  } catch (err) {
    return null;
  }
}

// on or off: "taint required" (AGENTS.talk) or "require taint" (a policy) keeps it on;
// then the command line wins over "taint on" and "taint off" in AGENTS.talk; the default is on
export function taintMode(agentsLine, policyRequires, commandLine) {
  if (agentsLine === "required" || policyRequires) {
    return "on";
  }
  return commandLine || agentsLine || "on";
}
