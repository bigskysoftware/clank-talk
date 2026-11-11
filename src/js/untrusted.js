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

// a session name as a folder name; a name of only dots would point to another folder
function folderName(session) {
  return String(session || "default").replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "_");
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

// the inputs of a session; a missing index is empty
// a broken index counts as one input that is not approved, so the session stays untrusted
export async function inputs(root, session) {
  let text;
  try {
    text = await fs.readFile(nodePath.join(folder(root, session), "index.json"), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return [];
    }
    return [broken(err.message)];
  }
  try {
    const entries = JSON.parse(text);
    if (Array.isArray(entries) && entries.every((entry) => entry !== null && typeof entry === "object" && Number.isInteger(entry.n) && entry.n > 0)) {
      return entries;
    }
  } catch (err) {
    // a broken index: below
  }
  return [broken("index.json is not a list of inputs")];
}

// a broken index is input 0; record and approve refuse to change it
function broken(reason) {
  return { n: 0, time: "", source: "a broken store: " + reason, size: 0, cut: false, file: "index.json", approved: false };
}

// one change at a time to a session's index, so two scripts in one process cannot lose an input
const locks = new Map();
async function locked(root, session, work) {
  const key = folder(root, session);
  const done = (locks.get(key) || Promise.resolve()).then(work);
  locks.set(key, done.catch(() => {}));
  return await done;
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
export async function record(root, session, input) {
  return await locked(root, session, () => recordNow(root, session, input));
}

async function recordNow(root, session, { source, text, time, keepBytes }) {
  const entries = await inputs(root, session);
  if (entries.some((entry) => entry.n === 0)) {
    throw new Error("the store is broken; a human must repair or remove " + storePath(session) + "index.json");
  }
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
  return await locked(root, session, () => approveNow(root, session, numbers, by));
}

async function approveNow(root, session, numbers, by) {
  const entries = await inputs(root, session);
  if (entries.some((entry) => entry.n === 0)) {
    return [];
  }
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

// the "keep audit" rules: delete the sessions whose newest input is from before the oldest kept day (2026-11-08)
// gives the names of the deleted sessions; a broken store is kept, for the human
export async function prune(root, oldestDay) {
  const deleted = [];
  for (const session of await sessions(root)) {
    const entries = await inputs(root, session);
    if (entries.some((entry) => entry.n === 0)) {
      continue;
    }
    const newest = entries.reduce((latest, entry) => (entry.time > latest ? entry.time : latest), "");
    if (newest.slice(0, 10) < oldestDay) {
      await locked(root, session, () => fs.rm(folder(root, session), { recursive: true, force: true }));
      deleted.push(session);
    }
  }
  return deleted;
}

// text from an input for a terminal or a question: control characters can hide text or move the cursor
// keepLines keeps line breaks and tabs, for the text of an input
export function printable(text, keepLines = false) {
  return String(text).replace(keepLines ? /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g : /[\u0000-\u001f\u007f-\u009f]/g, "?");
}

// keep the verdict of the judge; with approves, a "clean" verdict approves the input; gives true if it approved
export async function setVerdict(root, session, n, verdict, approves) {
  return await locked(root, session, async () => {
    const entries = await inputs(root, session);
    const entry = entries.find((item) => item.n === n && n > 0);
    if (entry === undefined) {
      return false;
    }
    entry.verdict = { result: verdict.result, reason: verdict.reason, time: localTime() };
    let approved = false;
    if (approves && verdict.result === "clean" && !entry.approved) {
      entry.approved = true;
      entry.approvedBy = "the judge";
      entry.approvedAt = new Date().toISOString();
      approved = true;
    }
    await save(root, session, entries);
    return approved;
  });
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
