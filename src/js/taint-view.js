// How the taint review shows the text of an input: the raw text with syntax colors, or HTML as a page shows it.
// The page view also lists all the text that a page hides: comments, scripts, styles, hidden elements and text attributes.
// An attack can hide there, so the human must see it. All text goes through printable, so it cannot send escape codes.

import * as untrusted from "./untrusted.js";

export const STYLES = {
  plain: "", tag: "\u001b[36m", attr: "\u001b[33m", value: "\u001b[32m", punct: "\u001b[34m", comment: "\u001b[2m",
  key: "\u001b[36m", string: "\u001b[32m", number: "\u001b[33m", literal: "\u001b[35m",
  heading: "\u001b[1;36m", link: "\u001b[2m", warn: "\u001b[1;33m", hidden: "\u001b[33m",
  label: "\u001b[2m", ref: "\u001b[1;36m", new: "\u001b[33m", clean: "\u001b[32m", suspect: "\u001b[1;31m", unsure: "\u001b[35m", approved: "\u001b[2;32m",
};

// html, json or text
export function kind(text) {
  const start = text.trimStart();
  if (/^(<!doctype html|<html|<head|<body)/i.test(start) || (start.startsWith("<") && /<\/[a-z][a-z0-9]*>/i.test(start))) {
    return "html";
  }
  if (/^[[{]/.test(start)) {
    try {
      JSON.parse(start);
      return "json";
    } catch (err) {
      // not JSON: below
    }
  }
  return "text";
}

// the screen lines of a text: each line is a list of [style, text] runs, no line wider than width
// page: for HTML, the page view; for JSON, pretty JSON
// numbers: room for line numbers; the first screen line of each text line gets .number, and each line gets .digits
export function displayLines(text, page, width, numbers = false) {
  const lines = viewLines(text, page);
  const digits = numbers ? String(lines.length).length : 0;
  return lines.flatMap((line, index) => wrapRuns(line, width - (numbers ? digits + 1 : 0)).map((screenLine, part) => {
    screenLine.number = numbers && part === 0 ? index + 1 : null;
    screenLine.digits = digits;
    return screenLine;
  }));
}

// the text of each line in a view, before the wrap: the line numbers count these; the judge for lines reads them
export function viewText(text, page) {
  return viewLines(text, page).map(lineText);
}

function viewLines(text, page) {
  const type = kind(text);
  let lines;
  if (type === "html" && page) {
    lines = renderHtml(text);
  } else if (type === "json") {
    const source = page ? JSON.stringify(JSON.parse(text), null, 2) : text;
    lines = splitLines(lexJson(clean(source)));
  } else if (type === "html") {
    lines = splitLines(lexHtml(clean(text)));
  } else {
    lines = splitLines([["plain", clean(text)]]);
  }
  return lines;
}

// the plain text of a screen line, for search
export function lineText(line) {
  return line.map((run) => run[1]).join("");
}

export function styleRuns(line) {
  return line.map(([style, text]) => (STYLES[style] ? STYLES[style] + text + "\u001b[0m" : text)).join("");
}

function clean(text) {
  return untrusted.printable(text, true).replace(/\t/g, "  ");
}

function splitLines(runs) {
  const lines = [[]];
  for (const [style, text] of runs) {
    text.split("\n").forEach((part, index) => {
      if (index > 0) {
        lines.push([]);
      }
      if (part !== "") {
        lines.at(-1).push([style, part]);
      }
    });
  }
  return lines;
}

// word wrap: break at a space in the second half of the line, else in the word
export function wrapRuns(line, width) {
  const size = Math.max(1, width);
  const chars = [];
  for (const [style, text] of line) {
    for (const char of text) {
      chars.push([style, char]);
    }
  }
  if (chars.length === 0) {
    return [[]];
  }
  const out = [];
  let start = 0;
  while (start < chars.length) {
    let end = Math.min(chars.length, start + size);
    let next = end;
    if (end < chars.length) {
      for (let at = end; at > start + Math.floor(size / 2); at--) {
        if (chars[at][1] === " ") {
          end = at;
          next = at + 1;
          break;
        }
      }
    }
    const runs = [];
    for (const [style, char] of chars.slice(start, end)) {
      if (runs.length > 0 && runs.at(-1)[0] === style) {
        runs.at(-1)[1] += char;
      } else {
        runs.push([style, char]);
      }
    }
    out.push(runs);
    start = next;
  }
  return out;
}

const JSON_TOKEN = /("(?:[^"\\\n]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],:])|([\s\S])/g;

function lexJson(text) {
  const runs = [];
  for (const match of text.matchAll(JSON_TOKEN)) {
    const [, string, colon, number, literal, punct, other] = match;
    if (string !== undefined) {
      runs.push([colon ? "key" : "string", string]);
      if (colon) {
        runs.push(["punct", colon]);
      }
    } else if (number !== undefined) {
      runs.push(["number", number]);
    } else if (literal !== undefined) {
      runs.push(["literal", literal]);
    } else if (punct !== undefined) {
      runs.push(["punct", punct]);
    } else {
      runs.push(["plain", other]);
    }
  }
  return runs;
}

// the index of the > that ends the tag at start; quotes can hold a >
function tagEnd(text, start) {
  let quote = null;
  for (let at = start + 1; at < text.length; at++) {
    const char = text[at];
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      }
    } else if (char === "\"" || char === "'") {
      quote = char;
    } else if (char === ">") {
      return at;
    }
  }
  return text.length - 1;
}

function startsTag(text, at) {
  return text[at] === "<" && /[a-zA-Z/!?]/.test(text[at + 1] || "");
}

// the runs of one tag: < name attr = "value" >
function tagTokens(source) {
  const out = [];
  const open = /^<\/?[!?]?/.exec(source)[0];
  out.push(["punct", open]);
  let at = open.length;
  const name = /^[^\s>/]*/.exec(source.slice(at))[0];
  if (name !== "") {
    out.push(["tag", name]);
  }
  at += name.length;
  while (at < source.length) {
    const rest = source.slice(at);
    const afterEquals = out.at(-1)[1] === "=";
    let found;
    if ((found = /^\s+/.exec(rest))) {
      out.push(["plain", found[0]]);
    } else if ((found = /^\/?>/.exec(rest))) {
      out.push(["punct", found[0]]);
    } else if ((found = /^=/.exec(rest))) {
      out.push(["punct", "="]);
    } else if (afterEquals && (found = /^("[^"]*"?|'[^']*'?|[^\s>]+)/.exec(rest))) {
      out.push(["value", found[0]]);
    } else if ((found = /^[^\s=>/]+/.exec(rest))) {
      out.push(["attr", found[0]]);
    } else {
      found = [rest[0]];
      out.push(["plain", rest[0]]);
    }
    at += found[0].length;
  }
  return out;
}

function lexHtml(text) {
  const runs = [];
  let at = 0;
  while (at < text.length) {
    if (text.startsWith("<!--", at)) {
      const end = text.indexOf("-->", at + 4);
      const stop = end === -1 ? text.length : end + 3;
      runs.push(["comment", text.slice(at, stop)]);
      at = stop;
    } else if (startsTag(text, at)) {
      const end = tagEnd(text, at);
      runs.push(...tagTokens(text.slice(at, end + 1)));
      at = end + 1;
    } else {
      const next = text.indexOf("<", at + 1);
      const stop = next === -1 ? text.length : next;
      runs.push(["plain", text.slice(at, stop)]);
      at = stop;
    }
  }
  return runs;
}

// [[name, value]] of a tag, names in lower case, values with no quotes
function attrsOf(tokens) {
  const attrs = [];
  tokens.forEach(([type, text], index) => {
    if (type === "attr") {
      const hasValue = tokens[index + 1] && tokens[index + 1][1] === "=" && tokens[index + 2] && tokens[index + 2][0] === "value";
      attrs.push([text.toLowerCase(), hasValue ? tokens[index + 2][1].replace(/^["']|["']$/g, "") : ""]);
    }
  });
  return attrs;
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const BLOCK = new Set(["address", "article", "aside", "blockquote", "body", "br", "dd", "div", "dl", "dt", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hr", "html", "li", "main", "nav", "ol", "p", "pre", "section", "table", "title", "tr", "ul"]);
// their text is not on the page
const RAW = new Set(["script", "style", "template", "noscript", "textarea"]);
// attributes with text that a page does not show, or shows only some of the time
const TEXT_ATTRS = /^(alt|title|aria-label|aria-description|aria-placeholder|placeholder|value|content|label|summary)$|^data-/;
const HIDING_STYLE = /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?![.\d])|opacity\s*:\s*0(?![.\d])|color\s*:\s*transparent|clip|(?:left|top|text-indent)\s*:\s*-\d{3,}|(?:width|height)\s*:\s*[01]px/i;
const HIDING_CLASS = /(^|\s)(hidden|sr-only|visually-hidden|d-none|invisible)(\s|$)/i;

function hides(attrs) {
  return attrs.some(([name, value]) => name === "hidden" || (name === "aria-hidden" && value === "true") || (name === "style" && HIDING_STYLE.test(value)) || (name === "class" && HIDING_CLASS.test(value)));
}

function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, code) => {
    const named = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " }[code.toLowerCase()];
    if (named !== undefined) {
      return named;
    }
    const number = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : "?";
  });
}

function collapse(text) {
  return decode(text).replace(/\s+/g, " ").trim();
}

// the page view: the text that a browser shows, then the text that it hides
function renderHtml(text) {
  const runs = [];
  const notes = [];
  const stack = [];
  const hidden = () => stack.some((entry) => entry.hidden);
  const inside = (test) => stack.some((entry) => test(entry.name));
  let at = 0;
  while (at < text.length) {
    if (text.startsWith("<!--", at)) {
      const end = text.indexOf("-->", at + 4);
      const stop = end === -1 ? text.length : end + 3;
      const body = collapse(text.slice(at + 4, end === -1 ? text.length : end));
      if (body !== "") {
        notes.push("comment: " + body);
      }
      at = stop;
      continue;
    }
    if (startsTag(text, at)) {
      const end = tagEnd(text, at);
      const tokens = tagTokens(text.slice(at, end + 1));
      at = end + 1;
      const name = tokens[1] && tokens[1][0] === "tag" ? tokens[1][1].toLowerCase() : "";
      if (tokens[0][1] === "</") {
        const index = stack.map((entry) => entry.name).lastIndexOf(name);
        if (index !== -1) {
          const [entry] = stack.splice(index);
          if (entry.href && !hidden() && !entry.hidden) {
            runs.push(["link", " <" + entry.href + ">"]);
          }
        }
        if (BLOCK.has(name)) {
          runs.push(["plain", "\n"]);
        }
        continue;
      }
      if (tokens[0][1] !== "<") {
        continue;
      }
      const attrs = attrsOf(tokens);
      for (const [attr, value] of attrs) {
        if (TEXT_ATTRS.test(attr) && /\p{L}/u.test(value)) {
          notes.push("<" + name + "> " + attr + ": " + collapse(value));
        }
      }
      if (RAW.has(name)) {
        const close = text.toLowerCase().indexOf("</" + name, at);
        const stop = close === -1 ? text.length : close;
        const body = collapse(text.slice(at, stop));
        if (body !== "") {
          notes.push(name + ": " + body);
        }
        at = close === -1 ? text.length : tagEnd(text, close) + 1;
        continue;
      }
      if (BLOCK.has(name)) {
        runs.push(["plain", "\n"]);
      }
      if (name === "li") {
        runs.push(["plain", "- "]);
      }
      if (!VOID.has(name) && tokens.at(-1)[1] !== "/>") {
        const href = name === "a" ? (attrs.find(([attr]) => attr === "href") || [])[1] : undefined;
        stack.push({ name, hidden: hides(attrs), href: href ? decode(href) : null });
      }
      continue;
    }
    const next = text.indexOf("<", at + 1);
    const stop = next === -1 ? text.length : next;
    let chunk = decode(text.slice(at, stop));
    at = stop;
    if (!inside((name) => name === "pre")) {
      chunk = chunk.replace(/\s+/g, " ");
    }
    if (hidden()) {
      if (chunk.trim() !== "") {
        notes.push("hidden element: " + chunk.trim());
      }
      continue;
    }
    runs.push([inside((name) => /^h[1-6]$/.test(name)) ? "heading" : "plain", chunk]);
  }
  // trim each line, and keep at most one empty line in a row
  const lines = [];
  for (const line of splitLines(runs.map(([style, part]) => [style, untrusted.printable(part.replace(/\t/g, "  "), true)]))) {
    if (line.length > 0) {
      line[0][1] = line[0][1].trimStart();
      line.at(-1)[1] = line.at(-1)[1].trimEnd();
    }
    const kept = line.filter((run) => run[1] !== "");
    if (kept.length > 0 || (lines.length > 0 && lines.at(-1).length > 0)) {
      lines.push(kept);
    }
  }
  lines.push([], [["warn", "\u2500\u2500 Not on the page: comments, scripts, styles, hidden elements, and text in attributes \u2500\u2500"]]);
  if (notes.length === 0) {
    lines.push([["comment", "(none)"]]);
  }
  for (const note of notes) {
    lines.push([["hidden", untrusted.printable(note)]]);
  }
  return lines;
}