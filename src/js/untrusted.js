// Session taint: the untrusted inputs that a session saw, kept for the human. See src/md/features/taint.md
//
// After the agent sees untrusted text (fetch, an untrusted tool, a subagent), the session is untrusted
// until the human approves each input. Each input is saved in @/.talk/untrusted/<session>/:
//   index.json   [{ n, time, source, size, cut, file, approved }]
//   <n>.txt      the source, the time, and the text
// Scripts cannot change @/.talk/, so the agent cannot change or remove what it read.

import fs from "node:fs/promises";
import nodePath from "node:path";
import { createHash } from "node:crypto";

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

// one change at a time to a session's index, so two writers cannot lose an input:
// a chain in this process, and a lock file (index.json.lock) for other processes, such as the command line
const locks = new Map();
async function locked(root, session, work) {
  const key = folder(root, session);
  const done = (locks.get(key) || Promise.resolve()).then(() => withLockFile(key, work));
  locks.set(key, done.catch(() => {}));
  return await done;
}

// a lock file that is older than this is left from a crash, and is taken over
const STALE_LOCK_MS = 10_000;

async function withLockFile(dir, work) {
  await fs.mkdir(dir, { recursive: true });
  const lock = nodePath.join(dir, "index.json.lock");
  const started = Date.now();
  while (true) {
    try {
      await (await fs.open(lock, "wx")).close();
      break;
    } catch (err) {
      if (err.code !== "EEXIST") {
        throw err;
      }
      let age = 0;
      try {
        age = Date.now() - (await fs.stat(lock)).mtimeMs;
      } catch (statErr) {
        continue;
      }
      if (age > STALE_LOCK_MS || Date.now() - started > STALE_LOCK_MS) {
        await fs.rm(lock, { force: true });
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  wroteOwnSync(lock, "lock");
  try {
    return await work();
  } finally {
    await fs.rm(lock, { force: true });
    deletedOwn(lock);
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

// write the index: a new file, then a rename, so a reader never sees half of it
// if the index changed since ClankTalk last wrote it (a program with no sandbox), the write is not noted as our own,
// so the check around that run still finds the change
async function save(root, session, entries) {
  await fs.mkdir(folder(root, session), { recursive: true });
  const index = nodePath.join(folder(root, session), "index.json");
  const changedOutside = await changedSinceOwn(index);
  const temporary = index + "." + process.pid + ".tmp";
  await fs.writeFile(temporary, JSON.stringify(entries, null, 2) + "\n");
  await fs.rename(temporary, index);
  if (!changedOutside) {
    await wroteOwn(index);
  }
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
  // the header is one line for each field: a line break in the source shows as ?
  await fs.writeFile(nodePath.join(folder(root, session), file), "source: " + printable(source) + "\ntime: " + time + (cut ? "\ncut: kept the first " + keepBytes + " of " + bytes.length + " bytes" : "") + "\n\n" + kept);
  await wroteOwn(nodePath.join(folder(root, session), file));
  const entry = { n, time, source, size: bytes.length, cut, file, approved: false };
  entries.push(entry);
  await save(root, session, entries);
  return entry;
}

// the inputs that are not approved
export function pending(entries) {
  return entries.filter((entry) => !entry.approved);
}

// the inputs that are not approved, in all sessions of the project: [{ session, entry }], oldest session first
// taint is for the whole project, so a resumed conversation (a new session) is still tainted by what it read before
export async function pendingAll(root) {
  const found = [];
  for (const session of await sessions(root)) {
    for (const entry of pending(await inputs(root, session))) {
      found.push({ session, entry });
    }
  }
  return found;
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
// only sessions where all inputs are approved: an input that is not approved keeps the project untrusted until a human looks
// gives the names of the deleted sessions; a broken store is kept, for the human
export async function prune(root, oldestDay) {
  const deleted = [];
  for (const session of await sessions(root)) {
    const gone = await locked(root, session, async () => {
      const entries = await inputs(root, session);
      if (entries.length === 0 || entries.some((entry) => entry.n === 0 || !entry.approved)) {
        return false;
      }
      const newest = entries.reduce((latest, entry) => (entry.time > latest ? entry.time : latest), "");
      if (newest.slice(0, 10) >= oldestDay) {
        return false;
      }
      await fs.rm(folder(root, session), { recursive: true, force: true });
      return true;
    });
    if (gone) {
      deletedOwn(folder(root, session));
      deleted.push(session);
    }
  }
  return deleted;
}

// ----- a check around a run with no sandbox -----
// Such a program runs as the user, so it can change .talk/. Before the run, ClankTalk keeps a hash of each file
// in .talk/, a copy of the taint control files, and the last 1000 lines of the audit. After the run, it reports
// each changed file, puts back the control files, and shows the audit lines from before the run. Best effort.
// ClankTalk itself can write .talk/ during a run, for example a background subagent that writes the audit,
// so each write of its own is noted, and is not a change. Another process (a second server) can still look like one.

// absolute path -> the SHA-256 of what ClankTalk last wrote there, or "deleted" (a file or a folder)
const own = new Map();

// the copy of the audit: its last lines, from the newest audit file
const KEEP_LINES = 1000;

function hashOf(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

// note a write of ClankTalk's own, after it
// a folder that ClankTalk deleted, and then writes into again, is no longer "deleted": a later removal is a change
export async function wroteOwn(absolute) {
  let hash;
  try {
    hash = hashOf(await fs.readFile(absolute));
  } catch (err) {
    hash = "deleted";
  }
  wroteOwnSync(absolute, hash);
}

function wroteOwnSync(absolute, hash) {
  for (const [path, value] of own) {
    if (value === "deleted" && absolute.startsWith(path + nodePath.sep)) {
      own.delete(path);
    }
  }
  own.set(absolute, hash === "lock" ? hashOf(Buffer.alloc(0)) : hash);
}

// the file changed since ClankTalk last wrote it; false if ClankTalk did not write it before
async function changedSinceOwn(absolute) {
  const last = own.get(absolute);
  if (last === undefined) {
    return false;
  }
  let now;
  try {
    now = hashOf(await fs.readFile(absolute));
  } catch (err) {
    now = "deleted";
  }
  return now !== last;
}

// note a removal of ClankTalk's own: a file, or a folder and all in it
export function deletedOwn(absolute) {
  own.set(absolute, "deleted");
}

// the file is as ClankTalk itself last left it; hash is null for a file that is not there
function isOwn(absolute, hash) {
  const want = hash === null ? "deleted" : hash;
  if (own.get(absolute) === want) {
    return true;
  }
  if (hash === null) {
    for (const [path, value] of own) {
      if (value === "deleted" && absolute.startsWith(path + nodePath.sep)) {
        return true;
      }
    }
  }
  return false;
}

// the control files of session taint: small, and they decide if the session is untrusted, so they also go back
function isControl(relative) {
  return relative === STATE_FILE || relative === POLICY_FILE || (relative.startsWith(STORE + "/") && relative.endsWith("/index.json"));
}

// the last KEEP_LINES lines of a text
function lastLines(text) {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.slice(-KEEP_LINES);
}

// all of .talk/: { files: path (relative to the root) -> { hash, content }, audit: { file, lines } }
// content is kept only for the control files; audit holds the last lines of the newest audit file
export async function snapshot(root) {
  const files = new Map();
  const add = async (relative) => {
    const absolute = nodePath.join(root, relative);
    let stat;
    try {
      stat = await fs.lstat(absolute);
    } catch (err) {
      return;
    }
    if (stat.isDirectory()) {
      for (const name of await fs.readdir(absolute)) {
        await add(relative + "/" + name);
      }
      return;
    }
    // a link or another kind of file has a fixed text, so a change to it shows
    const buffer = stat.isFile() ? await fs.readFile(absolute) : Buffer.from("not a plain file");
    files.set(relative, { hash: hashOf(buffer), content: isControl(relative) ? buffer : null });
  };
  await add(".talk");
  const logs = [...files.keys()].filter((relative) => /^\.talk\/audit\/\d{4}-\d{2}-\d{2}\.(log|jsonl)$/.test(relative)).sort();
  let audit = null;
  if (logs.length > 0) {
    const file = logs[logs.length - 1];
    audit = { file, lines: lastLines(await fs.readFile(nodePath.join(root, file), "utf8")) };
  }
  return { files, audit };
}

// a link in .talk/ (or in place of it) lets a script reach the store through the link's target: remove each link
// a .talk that is not a folder becomes a folder again; gives the removed paths
export async function removeLinks(root) {
  const found = [];
  const walk = async (relative) => {
    const absolute = nodePath.join(root, relative);
    let stat;
    try {
      stat = await fs.lstat(absolute);
    } catch (err) {
      return;
    }
    if (stat.isSymbolicLink() || (relative === ".talk" && !stat.isDirectory())) {
      found.push(relative);
      // not noted as a removal of our own: the files behind the link must still show as changed
      await fs.rm(absolute, { force: true });
      if (relative === ".talk") {
        await fs.mkdir(absolute);
      }
      return;
    }
    if (stat.isDirectory()) {
      for (const name of await fs.readdir(absolute)) {
        await walk(relative + "/" + name);
      }
    }
  };
  await walk(".talk");
  return found;
}

// the command line reads this to know that a policy requires taint; the runtime writes it at each run
export const POLICY_FILE = ".talk/taint-policy.json";

export async function notePolicy(root, policyName) {
  const file = nodePath.join(root, POLICY_FILE);
  if (policyName === null) {
    await fs.rm(file, { force: true });
    deletedOwn(file);
    return;
  }
  await fs.mkdir(nodePath.join(root, ".talk"), { recursive: true });
  const text = JSON.stringify({ required: true, policy: policyName }) + "\n";
  let now = null;
  try {
    now = await fs.readFile(file, "utf8");
  } catch (err) {
    now = null;
  }
  if (now !== text) {
    await fs.writeFile(file, text);
    await wroteOwn(file);
  }
}

// the policy that requires taint, from the file above, or null
export async function policyRequires(root) {
  try {
    const state = JSON.parse(await fs.readFile(nodePath.join(root, POLICY_FILE), "utf8"));
    return state.required === true ? String(state.policy) : null;
  } catch (err) {
    return null;
  }
}

// compare with a snapshot; gives { changed, restored }: the changed paths, and the control files that went back
// first, links go away, so the control files go back into the real folder
// a control file goes back to its copy (or goes away, if it was not there); other files only show as changed
export async function check(root, before) {
  const links = await removeLinks(root);
  const after = await snapshot(root);
  const changed = [...links];
  const restored = [];
  const paths = new Set([...before.files.keys(), ...after.files.keys()]);
  for (const relative of paths) {
    const was = before.files.get(relative);
    const now = after.files.get(relative);
    const absolute = nodePath.join(root, relative);
    if ((was && now && was.hash === now.hash) || isOwn(absolute, now ? now.hash : null)) {
      continue;
    }
    if (!changed.includes(relative)) {
      changed.push(relative);
    }
    if (!isControl(relative)) {
      continue;
    }
    await fs.rm(absolute, { recursive: true, force: true });
    if (was) {
      await fs.mkdir(nodePath.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, was.content);
      await wroteOwn(absolute);
    } else {
      deletedOwn(absolute);
    }
    restored.push(relative);
  }
  return { changed: changed.sort(), restored: restored.sort() };
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
  await wroteOwn(nodePath.join(root, STATE_FILE));
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
