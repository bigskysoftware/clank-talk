// The full-screen taint review: npx clank-talk taint --tui ; see src/md/features/taint.md
// The human runs it in a terminal. The agent cannot: it has no terminal, and no shell in ClankTalk.
// The view is plain data, so tests can press keys and read the screen with no terminal.
// Left: the inputs. Right: the current input, with the verdict of the judge. vi keys.

import readline from "node:readline";
import * as untrusted from "./untrusted.js";
import { projectJudge } from "./runtime.js";
import { displayLines, kind, lineText, styleRuns, viewText, wrapRuns } from "./taint-view.js";

export const FOOTER_KEYS = [["?", "keys"], ["j/k", "move"], ["space", "mark"], ["V", "select"], ["a", "approve"], ["u", "undo"], ["J", "judge"], ["m", "view"], ["/", "search"], ["tab", "pane"], ["q", "quit"]];

export const HELP = [
  "Keys",
  "",
  "j k                 down, up",
  "g G                 first, last",
  "ctrl-d ctrl-u       half a page",
  "ctrl-f ctrl-b       a page",
  "ctrl-e ctrl-y       scroll the text, from either pane",
  "tab, l h            the text pane, the list",
  "space               mark the input",
  "V                   select: j/k extend, V marks, esc stops",
  "esc                 clear the marks",
  "a                   approve: the selection, the marks, or this input",
  "A                   approve all shown inputs (asks first)",
  "u                   undo the last approval",
  "U                   unapprove: the selection, or this input",
  "J                   the judge reads: the selection, the marks, or this input",
  "J (text pane)       the judge flags the sketchy lines of this input",
  "] [                 the next, the last flagged line",
  "/ n N               search the pane, next, back",
  "m                   HTML: the raw text, or the page and what it hides",
  "                    JSON: the raw text, or pretty JSON",
  "#                   line numbers on or off",
  ".                   show or hide the approved inputs",
  "r                   read the store again",
  "q                   quit",
  "",
  "Press any key.",
];

// each input on the disk: { ref, session, entry }, oldest session first
export async function loadItems(root) {
  const items = [];
  for (const session of await untrusted.sessions(root)) {
    for (const entry of await untrusted.inputs(root, session)) {
      items.push({ ref: session + "/" + entry.n, session, entry });
    }
  }
  return items;
}

export function createView(items) {
  return {
    items, cursor: 0, marks: new Set(), anchor: null, focus: "list", scroll: 0,
    showApproved: false, prompt: null, search: { list: "", text: "" }, pending: null, help: false,
    texts: new Map(), message: "", size: layout(80, 24), page: false, numbers: true, cache: null, flags: new Map(), undo: [],
  };
}

// the widths of the panes and the height of the body
export function layout(width, height) {
  const left = width < 60 ? Math.floor(width / 2) : Math.min(60, Math.max(24, Math.floor(width * 0.4)));
  return { width, left, right: Math.max(1, width - left - 2), body: Math.max(1, height - 2) };
}

// the inputs that the approved switch lets through
export function shown(view) {
  return view.items.filter((item) => view.showApproved || !item.entry.approved);
}

export function current(view) {
  return shown(view)[view.cursor] || null;
}

// a new list from the disk: the marks and the cursor stay on the same inputs
export function refresh(view, items) {
  const at = current(view);
  view.items = items;
  const open = new Set(items.filter((item) => !item.entry.approved).map((item) => item.ref));
  view.marks = new Set([...view.marks].filter((ref) => open.has(ref)));
  const list = shown(view);
  const index = at === null ? -1 : list.findIndex((item) => item.ref === at.ref);
  view.cursor = index === -1 ? Math.max(0, Math.min(view.cursor, list.length - 1)) : index;
  if (view.anchor !== null) {
    view.anchor = Math.min(view.anchor, Math.max(0, list.length - 1));
  }
}

// the refs that a, A and J act on: the selection, else the marks, else the current input; never approved inputs
// with approved: the approved inputs, for U
export function targets(view, approved = false) {
  const list = shown(view);
  let picked;
  if (view.anchor !== null) {
    picked = list.slice(Math.min(view.anchor, view.cursor), Math.max(view.anchor, view.cursor) + 1);
  } else if (list.some((item) => view.marks.has(item.ref))) {
    picked = list.filter((item) => view.marks.has(item.ref));
  } else {
    picked = list.slice(view.cursor, view.cursor + 1);
  }
  return picked.filter((item) => Boolean(item.entry.approved) === approved).map((item) => item.ref);
}

// the flags of the judge for lines: line number to reason, for one input in one view
function flagKey(view, item) {
  return item.ref + " " + view.page;
}

// ] and [: scroll to the next or the last flagged line, and show its reason
function jumpFlag(view, back) {
  const item = current(view);
  const flags = item === null ? undefined : view.flags.get(flagKey(view, item));
  if (flags === undefined || flags.size === 0) {
    view.message = "No flagged lines. In the text pane, J asks the judge.";
    return;
  }
  view.numbers = true;
  const lines = textLines(view, item, view.size.right);
  let top = 0;
  for (let at = Math.min(view.scroll, lines.length - 1); at >= 0; at--) {
    if (lines[at].number !== null) {
      top = lines[at].number;
      break;
    }
  }
  const numbers = [...flags.keys()];
  const target = back
    ? [...numbers].reverse().find((number) => number < top) ?? numbers.at(-1)
    : numbers.find((number) => number > top) ?? numbers[0];
  view.scroll = Math.max(0, lines.findIndex((line) => line.number === target));
  view.message = "line " + target + ": " + untrusted.printable(flags.get(target));
}

// smartcase, as in vi: a pattern with a capital letter matches case
function matcher(pattern) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped, /[A-Z]/.test(pattern) ? "g" : "gi");
}

function matches(line, pattern) {
  const re = matcher(pattern);
  return re.test(line);
}

// the next line at or after from (or before, back) that matches, with wrap around; -1 if none
function findLine(lines, pattern, from, back) {
  for (let step = 0; step < lines.length; step++) {
    const index = ((back ? from - step : from + step) % lines.length + lines.length) % lines.length;
    if (matches(lines[index], pattern)) {
      return index;
    }
  }
  return -1;
}

function listLine(item) {
  return item.ref + " " + status(item.entry) + " " + untrusted.printable(item.entry.source);
}

function search(view, pattern, back, skip) {
  if (pattern === "") {
    view.message = "No search. Press / to search.";
    return;
  }
  if (view.focus === "list") {
    const list = shown(view);
    const at = list.length === 0 ? -1 : findLine(list.map(listLine), pattern, view.cursor + (skip ? (back ? -1 : 1) : 0), back);
    if (at === -1) {
      view.message = "Not found: " + pattern;
    } else {
      moveTo(view, at);
    }
    return;
  }
  const lines = textLines(view, current(view), view.size.right).map(lineText);
  const at = lines.length === 0 ? -1 : findLine(lines, pattern, view.scroll + (skip ? (back ? -1 : 1) : 0), back);
  if (at === -1) {
    view.message = "Not found: " + pattern;
  } else {
    view.scroll = at;
  }
}

function moveTo(view, index) {
  const list = shown(view);
  const next = Math.max(0, Math.min(list.length - 1, index));
  if (next !== view.cursor) {
    view.scroll = 0;
  }
  view.cursor = next;
}

// one key: a name (up, down, left, right, pageup, pagedown, return, escape, backspace, space, tab, ctrl-d and more) or one character
// gives null, or an action for the runner: { type: "approve" | "judge", refs }, { type: "reload" } or { type: "quit" }
export function press(view, key) {
  view.message = "";
  if (view.pending !== null) {
    const refs = view.pending;
    view.pending = null;
    if (key === "y") {
      return { type: "approve", refs };
    }
    view.message = "Nothing was approved.";
    return null;
  }
  if (view.prompt !== null) {
    if (key === "return") {
      view.search[view.focus] = view.prompt;
      view.prompt = null;
      search(view, view.search[view.focus], false, true);
    } else if (key === "escape") {
      view.prompt = null;
    } else if (key === "backspace") {
      view.prompt = view.prompt.slice(0, -1);
    } else if (key === "space") {
      view.prompt += " ";
    } else if ([...key].length === 1) {
      view.prompt += key;
    }
    return null;
  }
  if (view.help) {
    view.help = false;
    return null;
  }
  const list = shown(view);
  const item = list[view.cursor];
  const half = Math.max(1, Math.floor(view.size.body / 2));
  switch (key) {
    case "q":
    case "ctrl-c":
      return { type: "quit" };
    case "?":
      view.help = true;
      return null;
    case "r":
      return { type: "reload" };
    case ".":
      view.showApproved = !view.showApproved;
      view.cursor = 0;
      view.anchor = null;
      return null;
    case "ctrl-e":
      view.scroll += 1;
      return null;
    case "ctrl-y":
      view.scroll = Math.max(0, view.scroll - 1);
      return null;
    case "#":
      view.numbers = !view.numbers;
      return null;
    case "m":
      view.page = !view.page;
      view.scroll = 0;
      return null;
    case "tab":
      view.focus = view.focus === "list" ? "text" : "list";
      return null;
    case "/":
      view.prompt = "";
      return null;
    case "n":
    case "N":
      search(view, view.search[view.focus], key === "N", true);
      return null;
    case "a": {
      const refs = targets(view);
      view.anchor = null;
      if (refs.length === 0) {
        view.message = "Nothing to approve.";
        return null;
      }
      return { type: "approve", refs };
    }
    case "A": {
      const refs = list.filter((each) => !each.entry.approved).map((each) => each.ref);
      if (refs.length === 0) {
        view.message = "Nothing to approve.";
      } else {
        view.pending = refs;
      }
      return null;
    }
    case "u":
      if (view.undo.length === 0) {
        view.message = "Nothing to undo.";
        return null;
      }
      return { type: "unapprove", refs: view.undo.pop() };
    case "U": {
      const refs = targets(view, true);
      view.anchor = null;
      if (refs.length === 0) {
        view.message = "Nothing to unapprove. Press . to show the approved inputs.";
        return null;
      }
      return { type: "unapprove", refs };
    }
    case "]":
    case "[":
      jumpFlag(view, key === "[");
      return null;
    case "J": {
      if (view.focus === "text" && item !== undefined) {
        return { type: "judgeLines", ref: item.ref, page: view.page };
      }
      const refs = targets(view);
      view.anchor = null;
      if (refs.length === 0) {
        view.message = "Nothing to judge.";
        return null;
      }
      return { type: "judge", refs };
    }
    case "space":
      if (item !== undefined && !item.entry.approved && !view.marks.delete(item.ref)) {
        view.marks.add(item.ref);
      }
      if (view.focus === "list") {
        moveTo(view, view.cursor + 1);
      }
      return null;
    case "V":
      if (view.anchor === null) {
        view.anchor = view.cursor;
        view.focus = "list";
      } else {
        for (const ref of targets(view)) {
          view.marks.add(ref);
        }
        view.anchor = null;
      }
      return null;
    case "escape":
      if (view.anchor !== null) {
        view.anchor = null;
      } else if (view.focus === "text") {
        view.focus = "list";
      } else {
        view.marks.clear();
      }
      return null;
  }
  if (view.focus === "list") {
    const moves = {
      j: 1, down: 1, k: -1, up: -1, "ctrl-d": half, "ctrl-u": -half,
      "ctrl-f": view.size.body, pagedown: view.size.body, "ctrl-b": -view.size.body, pageup: -view.size.body,
    };
    if (key in moves) {
      moveTo(view, view.cursor + moves[key]);
    } else if (key === "g") {
      moveTo(view, 0);
    } else if (key === "G") {
      moveTo(view, list.length - 1);
    } else if ((key === "l" || key === "right" || key === "return") && item !== undefined) {
      view.focus = "text";
    }
    return null;
  }
  const moves = {
    j: 1, down: 1, k: -1, up: -1, "ctrl-d": half, "ctrl-u": -half,
    "ctrl-f": view.size.body, pagedown: view.size.body, "ctrl-b": -view.size.body, pageup: -view.size.body,
  };
  if (key in moves) {
    view.scroll = Math.max(0, view.scroll + moves[key]);
  } else if (key === "g") {
    view.scroll = 0;
  } else if (key === "G") {
    view.scroll = Number.MAX_SAFE_INTEGER;
  } else if (key === "h" || key === "left") {
    view.focus = "list";
  }
  return null;
}

// SGR codes as [on, off]; each off ends only its own style, so a row keeps its background
const SGR = {
  bold: ["1", "22"], dim: ["2", "22"], inverse: ["7", "27"],
  red: ["31", "39"], green: ["32", "39"], yellow: ["33", "39"], magenta: ["35", "39"], cyan: ["36", "39"],
  bar: ["48;5;236", "49"], cursor: ["48;5;238", "49"], cursorIdle: ["48;5;235", "49"],
};

function paint(names, text) {
  if (names.length === 0 || text === "") {
    return text;
  }
  const on = names.map((name) => "\u001b[" + SGR[name][0] + "m").join("");
  const off = [...names].reverse().map((name) => "\u001b[" + SGR[name][1] + "m").join("");
  return on + text + off;
}

// at most width characters; styles go on after the cut, so a cut never splits one
function cut(text, width) {
  return [...text].slice(0, Math.max(0, width)).join("");
}

// [[styles, text]] runs, cut to width; with fill, spaces to the full width
function fit(runs, width, fill = true) {
  let room = Math.max(0, width);
  let out = "";
  for (const [names, text] of runs) {
    const part = cut(text, room);
    room -= [...part].length;
    out += paint(names, part);
  }
  return fill ? out + " ".repeat(room) : out;
}

const STATUS = { new: ["yellow"], clean: ["green"], suspect: ["red", "bold"], unsure: ["magenta"], approved: ["green", "dim"] };

function sizeText(bytes) {
  if (bytes < 1024) {
    return bytes + " B";
  }
  return bytes >= 1024 * 1024 ? Math.ceil(bytes / (1024 * 1024)) + " MB" : Math.ceil(bytes / 1024) + " KB";
}

// the text of an input, with no header lines
function bodyOf(view, item) {
  const text = item === null ? undefined : view.texts.get(item.ref);
  if (text === undefined) {
    return undefined;
  }
  const start = text.indexOf("\n\n");
  return start === -1 ? text : text.slice(start + 2);
}

// the text of an input as screen lines of [style, text] runs; see taint-view.js
function textLines(view, item, width) {
  const body = bodyOf(view, item);
  if (body === undefined) {
    return item === null ? [] : [[["label", "(loading)"]]];
  }
  const key = item.ref + " " + view.page + " " + view.numbers + " " + width;
  if (view.cache === null || view.cache.key !== key || view.cache.body !== body) {
    view.cache = { key, body, lines: displayLines(body, view.page, width, view.numbers) };
  }
  return view.cache.lines;
}

function status(entry) {
  if (entry.approved) {
    return "approved";
  }
  return entry.verdict ? entry.verdict.result : "new";
}

// the rule under the header: the kind of text, and what m does
function ruleText(view, item) {
  const body = bodyOf(view, item);
  const type = body === undefined ? "text" : kind(body);
  let label = type;
  if (type === "html") {
    label = view.page ? "html, page view (m: raw)" : "html, raw (m: page view)";
  } else if (type === "json") {
    label = view.page ? "json, pretty (m: raw)" : "json, raw (m: pretty)";
  }
  return "\u2500\u2500 " + label + " " + "\u2500".repeat(view.size.right);
}

function helpLine(line, width) {
  if (line === "Keys") {
    return fit([[["bold", "cyan"], line]], width, false);
  }
  if (line.startsWith("Press")) {
    return fit([[["dim"], line]], width, false);
  }
  return fit([[["bold", "yellow"], line.slice(0, 20)], [[], line.slice(20)]], width, false);
}

// the right pane: the header of the current input, then its text from the scroll
function rightPane(view, item) {
  const { right, body } = view.size;
  if (view.help) {
    return HELP.map((line) => helpLine(line, right));
  }
  if (item === null) {
    return [];
  }
  const { entry } = item;
  const state = status(entry);
  const flags = view.flags.get(flagKey(view, item));
  const verdict = entry.verdict
    ? [[entry.verdict.result, entry.verdict.result], ["plain", entry.verdict.reason ? ": " + untrusted.printable(entry.verdict.reason) : ""]]
    : [["label", "- (J asks the judge)"]];
  const header = [
    [["ref", item.ref], ["plain", "  "], [state, state], ["label", entry.approvedBy ? " by " + entry.approvedBy : ""]],
    [["label", "source  "], ["plain", untrusted.printable(entry.source)]],
    [["label", "time    "], ["plain", entry.time], ["label", "   size  "], ["plain", sizeText(entry.size) + (entry.cut ? " (cut)" : "")]],
    [["label", "judge   "], ...verdict],
    ...(flags === undefined ? [] : [[["label", "lines   "], flags.size === 0 ? ["clean", "no sketchy lines"] : ["suspect", flags.size + (flags.size === 1 ? " sketchy line" : " sketchy lines")], ["label", flags.size === 0 ? "" : "  ] next  [ last"]]]),
  ].flatMap((line) => wrapRuns(line.filter((run) => run[1] !== ""), right).map(styleRuns));
  header.push(fit([[view.focus === "text" ? ["cyan"] : ["dim"], ruleText(view, item)]], right, false));
  const lines = textLines(view, item, right);
  const room = Math.max(1, body - header.length);
  view.scroll = Math.max(0, Math.min(view.scroll, lines.length - room));
  const pattern = view.search.text;
  const shownLines = lines.slice(view.scroll, view.scroll + room).map((line) => {
    const text = lineText(line);
    const flagged = flags !== undefined && line.number !== null && flags.has(line.number);
    const gutter = line.digits ? paint(["dim"], String(line.number ?? "").padStart(line.digits)) + (flagged ? paint(["bold", "red"], "!") : " ") : "";
    // a line with a match loses its colors, so the match stands out
    return gutter + (pattern !== "" && matches(text, pattern) ? text.replace(matcher(pattern), (found) => paint(["inverse"], found)) : styleRuns(line));
  });
  return [...header, ...shownLines];
}

// the color of a message in the footer
function tone(message) {
  if (/^(Approved|Judge:)/.test(message)) {
    return ["green", "bold"];
  }
  if (/^(Nothing|No search|No flagged|The judge reads|Unapproved|line \d)/.test(message)) {
    return ["yellow"];
  }
  return ["red", "bold"];
}

function keyRuns(pairs) {
  return pairs.flatMap(([key, label], index) => [[[], index === 0 ? "" : "  "], [["bold", "cyan"], key], [["dim"], " " + label]]);
}

function footerLine(view, width) {
  if (view.pending !== null) {
    const count = view.pending.length + (view.pending.length === 1 ? " input" : " inputs");
    return fit([[["bold", "yellow"], "Approve " + count + "?"], [[], " "], [["bold"], "y"], [["dim"], " or "], [["bold"], "n"]], width, false);
  }
  if (view.prompt !== null) {
    return fit([[["bold", "yellow"], "/"], [[], untrusted.printable(view.prompt)], [["inverse"], " "]], width, false);
  }
  if (view.message !== "") {
    return fit([[tone(view.message), view.message]], width, false);
  }
  if (view.anchor !== null) {
    return fit([[["bold", "magenta"], "-- SELECT --"], [[], "  "], ...keyRuns([["j/k", "extend"], ["a", "approve"], ["u", "undo"], ["J", "judge"], ["V", "mark"], ["esc", "stop"]])], width, false);
  }
  return fit(keyRuns(FOOTER_KEYS), width, false);
}

// the screen: exactly height lines, none wider than width
export function render(view, width, height) {
  view.size = layout(width, height);
  const { left, body } = view.size;
  const list = shown(view);
  const waiting = view.items.filter((each) => !each.entry.approved).length;
  const title = [[["bold", "cyan"], " Taint review"], [[], "   "], [waiting === 0 ? ["green"] : ["bold", "yellow"], waiting + " not approved"]];
  if (view.marks.size > 0) {
    title.push([[], "   "], [["bold", "cyan"], view.marks.size + " marked"]);
  }
  if (view.showApproved) {
    title.push([[], "   "], [["dim"], "approved shown"]);
  }
  const low = view.anchor === null ? -1 : Math.min(view.anchor, view.cursor);
  const high = view.anchor === null ? -1 : Math.max(view.anchor, view.cursor);
  const start = Math.max(0, Math.min(view.cursor - Math.floor(body / 2), list.length - body));
  const rows = list.slice(start, start + body).map((each, index) => {
    const at = start + index;
    const marked = view.marks.has(each.ref) || (at >= low && at <= high);
    const state = status(each.entry);
    const row = fit([
      [["bold", "cyan"], marked ? "*" : " "],
      [["dim"], String(each.entry.n).padStart(4) + " "],
      [STATUS[state] || [], state.padEnd(9)],
      [[], untrusted.printable(each.entry.source)],
    ], left - 1) + " ";
    if (at !== view.cursor) {
      return row;
    }
    return paint([view.focus === "list" ? "cursor" : "cursorIdle"], row);
  });
  if (list.length === 0) {
    rows.push(fit([[["dim"], view.items.length === 0 ? " No untrusted inputs." : " All approved. Press . to show them."]], left));
  }
  const right = rightPane(view, current(view));
  const lines = [paint(["bar"], fit(title, width))];
  for (let row = 0; row < body; row++) {
    // spaces on each side of the bar, so a terminal does not make one link of the two panes
    lines.push((rows[row] || " ".repeat(left)) + paint(view.focus === "text" ? ["cyan"] : ["dim"], "\u2502") + " " + (right[row] || ""));
  }
  lines.push(footerLine(view, width));
  return lines;
}

// approve the inputs with these refs; gives the count that changed
// u undoes the last one
export async function approveRefs(root, view, refs) {
  const done = [];
  for (const [session, numbers] of bySession(view, refs)) {
    done.push(...(await untrusted.approve(root, session, numbers, "the taint review")).map((n) => session + "/" + n));
  }
  for (const ref of refs) {
    view.marks.delete(ref);
  }
  if (done.length > 0) {
    view.undo.push(done);
  }
  return done.length;
}

// take back approvals; gives the count that changed
export async function unapproveRefs(root, view, refs) {
  let count = 0;
  for (const [session, numbers] of bySession(view, refs)) {
    count += (await untrusted.unapprove(root, session, numbers)).length;
  }
  return count;
}

// the judge flags the sketchy lines of one input, in the view that the human sees; gives a line for the footer
export async function judgeLinesOf(root, view, ref, page, options = {}) {
  const item = view.items.find((each) => each.ref === ref);
  const body = item === undefined ? undefined : bodyOf(view, item);
  if (body === undefined) {
    return "The text is not read yet. Try again.";
  }
  const setup = await projectJudge(root, options);
  if (setup.error) {
    return setup.error;
  }
  const answer = await setup.lines(item.entry.source, viewText(body, page).join("\n"));
  if (!answer.valid) {
    return "The answer of the judge was not valid. No lines are flagged.";
  }
  view.flags.set(ref + " " + page, new Map(answer.lines.map(({ line, reason }) => [line, reason])));
  view.numbers = true;
  const count = answer.lines.length;
  return count === 0 ? "Judge: no sketchy lines." : "Judge: " + count + (count === 1 ? " sketchy line" : " sketchy lines") + ". ] goes to the next.";
}

function bySession(view, refs) {
  const sessions = new Map();
  for (const ref of refs) {
    const item = view.items.find((each) => each.ref === ref);
    if (item !== undefined) {
      sessions.set(item.session, [...(sessions.get(item.session) || []), item.entry.n]);
    }
  }
  return sessions;
}

// the judge reads the inputs with these refs, and keeps each verdict; gives a line for the footer
export async function judgeRefs(root, view, refs, options = {}) {
  const setup = await projectJudge(root, options);
  if (setup.error) {
    return setup.error;
  }
  const results = [];
  for (const ref of refs) {
    const item = view.items.find((each) => each.ref === ref);
    if (item === undefined) {
      continue;
    }
    const text = await untrusted.inputText(root, item.session, item.entry);
    try {
      const verdict = await setup.judge(item.entry.source, text.slice(text.indexOf("\n\n") + 2));
      const approved = await untrusted.setVerdict(root, item.session, item.entry.n, verdict, setup.approves);
      results.push(item.entry.n + " " + verdict.result + (approved ? " (approved)" : ""));
    } catch (err) {
      results.push(item.entry.n + " failed: " + untrusted.printable(err.message));
    }
  }
  return "Judge: " + results.join(", ");
}

const NAMED = new Set(["up", "down", "left", "right", "pageup", "pagedown", "return", "escape", "backspace", "space", "tab"]);

// a readline key as a name for press: ctrl-d, up, or the character
export function keyName(text, key = {}) {
  if (key.ctrl && key.name) {
    return "ctrl-" + key.name;
  }
  if (NAMED.has(key.name)) {
    return key.name;
  }
  return text;
}

// runs the review in the terminal until q; gives the exit code
// options.lendModel: for tests, a model for the judge
export async function runTui(root, input, output, out, options = {}) {
  if (!input.isTTY || !output.isTTY) {
    out("taint --tui needs a terminal. Run it in a terminal, or use: npx clank-talk taint");
    return 1;
  }
  const view = createView(await loadItems(root));
  // one step at a time: keys, reloads, approvals and the judge do not overlap
  let chain = Promise.resolve();
  let closed = false;
  const draw = () => {
    if (closed) {
      return;
    }
    const lines = render(view, output.columns || 80, output.rows || 24);
    output.write("\u001b[H" + lines.map((line) => line + "\u001b[K").join("\r\n") + "\u001b[J");
  };
  // the text of the current input, read once
  const loadText = async () => {
    const item = current(view);
    if (item !== null && !view.texts.has(item.ref) && item.entry.n > 0) {
      try {
        view.texts.set(item.ref, await untrusted.inputText(root, item.session, item.entry));
      } catch (err) {
        view.texts.set(item.ref, "The text cannot be read: " + err.message);
      }
    }
  };
  const reload = async () => {
    refresh(view, await loadItems(root));
    await loadText();
  };
  return await new Promise((resolve) => {
    const step = (work) => {
      chain = chain.then(work).then(draw, (err) => {
        view.message = "Error: " + err.message;
        draw();
      });
    };
    const timer = setInterval(() => step(reload), 2000);
    const finish = () => {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(timer);
      input.removeListener("keypress", onKey);
      output.removeListener("resize", draw);
      input.setRawMode(false);
      input.pause();
      output.write("\u001b[?25h\u001b[?1049l");
      resolve(0);
    };
    const onKey = (text, key) => {
      const name = keyName(text, key);
      if (name === undefined) {
        return;
      }
      step(async () => {
        const action = press(view, name);
        if (action === null) {
          await loadText();
        } else if (action.type === "quit") {
          finish();
        } else if (action.type === "reload") {
          await reload();
        } else if (action.type === "approve") {
          const count = await approveRefs(root, view, action.refs);
          await reload();
          view.message = "Approved " + count + (count === 1 ? " input." : " inputs.");
        } else if (action.type === "judge") {
          view.message = "The judge reads " + action.refs.length + (action.refs.length === 1 ? " input..." : " inputs...");
          draw();
          const line = await judgeRefs(root, view, action.refs, options);
          await reload();
          view.message = line;
        } else if (action.type === "judgeLines") {
          view.message = "The judge reads the lines...";
          draw();
          view.message = await judgeLinesOf(root, view, action.ref, action.page, options);
        } else if (action.type === "unapprove") {
          const count = await unapproveRefs(root, view, action.refs);
          await reload();
          view.message = "Unapproved " + count + (count === 1 ? " input." : " inputs.");
        }
      });
    };
    output.write("\u001b[?1049h\u001b[?25l");
    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    input.on("keypress", onKey);
    output.on("resize", draw);
    step(loadText);
  });
}