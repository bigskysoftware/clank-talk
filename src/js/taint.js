// Taint: labels that say where a value came from. See src/md/features/taint.md
//
// Labels go on expressions, not on each value. Each expression and each command
// has a frame that collects the labels of what it reads. An expression's frame
// goes into the frame around it; a command's frame does not, so control flow
// gives no labels. Variables and the result keep one set of labels next to the
// value. A list or object keeps its labels with it, wherever it goes.
//
// A set of labels is a Map: label name -> list of origins (URLs or tool names).

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
  const parts = [];
  for (const [label, origins] of labels) {
    parts.push(origins.length === 0 ? label : label + " from " + origins.join(", "));
  }
  return "  (" + parts.join(", ") + ")";
}
