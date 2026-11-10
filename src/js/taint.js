// Taint: labels that say where a value came from. See src/md/features/taint.md
//
// Labels go on expressions, not on each value. Each expression and each command
// has a frame that collects the labels of what it reads. An expression's frame
// goes into the frame around it; a command's frame does not, so control flow
// gives no labels. Variables and the result keep one set of labels next to the
// value. A list or object keeps its labels with it, wherever it goes.
//
// A set of labels is a Map: label name -> list of origins (URLs or tool names).

import fs from "node:fs/promises";
import nodePath from "node:path";
import { createHash } from "node:crypto";

export const PRIVATE = "private";
export const UNTRUSTED = "untrusted";

// an untrusted label keeps at most this many origins
const MAX_ORIGINS = 5;

// the labels of lists and objects, by the object itself
const objectLabels = new WeakMap();

// the labels of variables: scope object -> Map of name -> labels
const slotLabels = new WeakMap();

export function none() {
  return new Map();
}

// a new set with the labels of both
export function union(a, b) {
  const result = new Map(a);
  for (const [label, origins] of b) {
    const merged = result.has(label) ? [...result.get(label)] : [];
    for (const origin of origins) {
      if (!merged.includes(origin) && merged.length < MAX_ORIGINS) {
        merged.push(origin);
      }
    }
    result.set(label, merged);
  }
  return result;
}

export function has(labels, label) {
  return labels.has(label);
}

// a new set with one label left out
export function without(labels, label) {
  const result = new Map(labels);
  result.delete(label);
  return result;
}

// ----- frames -----

// start a frame; a root frame (a command) does not go into the frame around it
export function begin(state, root) {
  state.taintFrames.push({ labels: none(), root: root === true });
}

// end a frame; an expression's labels go into the frame around it
// gives the labels of the frame
export function end(state) {
  const frame = state.taintFrames.pop();
  const outer = state.taintFrames[state.taintFrames.length - 1];
  if (!frame.root && outer !== undefined) {
    outer.labels = union(outer.labels, frame.labels);
  }
  return frame.labels;
}

// the labels of the frame now open
export function current(state) {
  const frame = state.taintFrames[state.taintFrames.length - 1];
  return frame === undefined ? none() : frame.labels;
}

// add labels to the frame now open
export function add(state, labels) {
  const frame = state.taintFrames[state.taintFrames.length - 1];
  if (frame !== undefined && labels.size > 0) {
    frame.labels = union(frame.labels, labels);
  }
}

// add one label, with an origin or none
export function addLabel(state, label, origin) {
  add(state, new Map([[label, origin ? [origin] : []]]));
}

// ----- values -----

// a list or object that an expression gives back takes the frame's labels, and gives its own to the frame
// canLabel is false for values that are not data, such as a file reference
export function withValue(state, value, canLabel) {
  if (!canLabel || value === null || typeof value !== "object") {
    return;
  }
  const own = objectLabels.get(value);
  if (own !== undefined) {
    add(state, own);
  }
  const frame = current(state);
  if (frame.size > 0) {
    objectLabels.set(value, union(own || none(), frame));
  }
}

// a list or object takes these labels too, for example a hook step
export function attach(value, labels) {
  if (value === null || typeof value !== "object" || labels.size === 0) {
    return;
  }
  objectLabels.set(value, union(objectLabels.get(value) || none(), labels));
}

// ----- variables -----

export function setSlot(scope, name, labels) {
  let slots = slotLabels.get(scope);
  if (slots === undefined) {
    slots = new Map();
    slotLabels.set(scope, slots);
  }
  slots.set(name, labels);
}

export function slot(scope, name) {
  const slots = slotLabels.get(scope);
  if (slots === undefined || !slots.has(name)) {
    return none();
  }
  return slots.get(name);
}

// ----- questions at the sinks -----

// a long argument or message is cut in a question
const QUESTION_TEXT = 120;

// the origins of a label, for a question: "https://a, https://b", or "an unknown place"
export function originsText(labels, label) {
  const origins = labels.get(label) || [];
  return origins.length === 0 ? "an unknown place" : origins.join(", ");
}

// Run npm with untrusted text from https://example.com/notes: install left-pad?
export function untrustedQuestion(action, labels, text) {
  const shown = text.length > QUESTION_TEXT ? text.slice(0, QUESTION_TEXT - 3) + "..." : text;
  return action + " with untrusted text from " + originsText(labels, UNTRUSTED) + ": " + shown + "?";
}

// ----- for hooks and the audit -----

// [{ label: 'untrusted', from: ['https://...'] }, { label: 'private', from: [] }]
export function forHook(labels) {
  const list = [];
  for (const [label, origins] of labels) {
    list.push({ label, from: [...origins] });
  }
  return list;
}

// the end of an audit line: "  (private, untrusted from https://a, https://b)"
export function note(labels) {
  if (labels.size === 0) {
    return "";
  }
  return "  (" + describe(labels) + ")";
}

// "private, untrusted from https://a, https://b"
export function describe(labels) {
  const parts = [];
  for (const [label, origins] of labels) {
    parts.push(origins.length === 0 ? label : label + " from " + origins.join(", "));
  }
  return parts.join(", ");
}

// ----- file labels -----
//
// A file that a script wrote with untrusted text remembers its labels, in @/.talk/taint.json:
//   { "notes.md": { "hash": "...", "labels": [{ "label": "untrusted", "from": ["https://..."] }],
//                   "time": "2026-11-10 10:42", "session": "claude-code-4f2a", "script": 12 } }
// Only files with a label beyond private are there. Scripts cannot change @/.talk/.
// If a file's text no longer matches its hash, it changed outside ClankTalk, and the entry is dropped.

export const FILE_LABELS = ".talk/taint.json";

export function hashText(text) {
  return createHash("sha256").update(text).digest("hex");
}

// the entries, by path; a missing or broken file is empty
export async function loadFiles(root) {
  try {
    const files = JSON.parse(await fs.readFile(nodePath.join(root, FILE_LABELS), "utf8"));
    if (files !== null && typeof files === "object" && !Array.isArray(files)) {
      return files;
    }
  } catch (err) {
    // no file yet
  }
  return Object.create(null);
}

// the entries are sorted by path, so the file is easy to read and to compare
export async function saveFiles(root, files) {
  const sorted = {};
  for (const path of Object.keys(files).sort()) {
    sorted[path] = files[path];
  }
  const absolute = nodePath.join(root, FILE_LABELS);
  await fs.mkdir(nodePath.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, JSON.stringify(sorted, null, 2) + "\n", "utf8");
}

// labels from an entry, as a Map
export function entryLabels(entry) {
  const labels = new Map();
  for (const item of entry.labels || []) {
    labels.set(item.label, [...(item.from || [])]);
  }
  return labels;
}

// the text of a file: its entry's labels, "dropped" if the text changed outside ClankTalk, or none
export function forFileText(files, path, text) {
  const entry = files[path];
  if (entry === undefined) {
    return { labels: none(), dropped: false };
  }
  if (entry.hash !== hashText(text)) {
    delete files[path];
    return { labels: none(), dropped: true };
  }
  return { labels: entryLabels(entry), dropped: false };
}

// after a write: keep the untrusted labels with the new text; gives "set", "cleared" or null for no change
export function afterWrite(files, path, text, labels, where) {
  const kept = new Map();
  if (labels.has(UNTRUSTED)) {
    kept.set(UNTRUSTED, labels.get(UNTRUSTED));
  }
  if (kept.size === 0) {
    if (files[path] === undefined) {
      return null;
    }
    delete files[path];
    return "cleared";
  }
  files[path] = { hash: hashText(text), labels: forHook(kept), ...where };
  return "set";
}

export function moveFile(files, from, to) {
  if (files[from] === undefined) {
    return false;
  }
  files[to] = files[from];
  delete files[from];
  return true;
}

export function deleteFile(files, path) {
  if (files[path] === undefined) {
    return false;
  }
  delete files[path];
  return true;
}
