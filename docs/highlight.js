// Build-time syntax highlighter for ```talk code blocks, and a small one for ```bash blocks
// It uses the real tokenizer, so paths, urls, raw strings and 's follow the language's own rules.
// Comments are not tokens: they are found in the text between tokens.

import { tokenize } from "../src/js/tokenizer.js";

// words that get the keyword color: commands, and the words that shape expressions
const KEYWORDS = new Set([
  // commands and blocks
  "print", "set", "increment", "decrement", "if", "else", "end", "then", "do",
  "for", "in", "index", "repeat", "times", "while", "until", "break", "continue",
  "read", "write", "append", "replace", "find", "put", "remove", "with", "to", "by", "line", "lines",
  "tool", "import", "run", "start", "stop", "fetch", "ask", "wait", "undo", "help", "reject",
  "before", "after", "on", "error", "allow", "env", "changes", "git", "audit",
  "sandbox", "network", "local", "writes", "reads",
  // expressions
  "the", "it", "result", "true", "false", "null", "not", "no", "and", "or", "mod",
  "is", "less", "greater", "than", "equal", "contains", "does", "contain", "starts", "ends",
  "exists", "exist", "empty", "as", "json", "pretty", "text", "number", "response",
  "of", "within", "first", "last", "process", "processes", "list",
]);

function escape(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function span(cls, text) {
  return '<span class="tok-' + cls + '">' + escape(text) + "</span>";
}

// the text between tokens: spaces, and comments from # to the end of the line
function gap(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "#") {
      let end = text.indexOf("\n", i);
      if (end === -1) {
        end = text.length;
      }
      out += span("comment", text.slice(i, end));
      i = end;
    } else {
      out += escape(text[i]);
      i++;
    }
  }
  return out;
}

// ----- the audit log, for the examples of .talk/audit/ -----
// a header (== ... ==), the script (indented, as ClankTalk), "--", then steps: time, kind, target, details

export function highlightAudit(text) {
  let inScript = false;
  return text.split("\n").map((line) => {
    if (line.startsWith("== ")) {
      inScript = true;
      const header = /^(== )(\d\d:\d\d:\d\d)(.*)$/.exec(line);
      return header === null ? span("comment", line) : span("comment", header[1]) + span("number", header[2]) + span("comment", header[3]);
    }
    if (line === "--") {
      inScript = false;
      return span("comment", line);
    }
    if (inScript) {
      return highlight(line);
    }
    const step = /^(\d\d:\d\d:\d\d)(\s+)(\S+)(\s+)(\S+(?: \S+)*?)(\s{2,}.*)?$/.exec(line);
    if (step === null) {
      return escape(line);
    }
    return span("number", step[1]) + step[2] + span("keyword", step[3]) + step[4] + span("path", step[5]) + (step[6] === undefined ? "" : span("comment", step[6]));
  }).join("\n");
}

// ----- JSON: keys, strings, numbers, and true, false and null -----

const JSON_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|\b(true|false|null)\b/g;

export function highlightJson(code) {
  let out = "";
  let at = 0;
  for (const match of code.matchAll(JSON_TOKEN)) {
    out += escape(code.slice(at, match.index));
    const [text, string, colon, number] = match;
    if (string !== undefined) {
      // a key is a string with a colon after it
      out += colon !== undefined ? span("keyword", string) + escape(colon) : span("string", string);
    } else if (number !== undefined) {
      out += span("number", text);
    } else {
      out += span("keyword", text);
    }
    at = match.index + text.length;
  }
  return out + escape(code.slice(at));
}

// ----- Markdown: headings, list marks, inline code and bold -----

export function highlightMarkdown(code) {
  return code.split("\n").map((line) => {
    if (/^#{1,6} /.test(line)) {
      return span("keyword", line);
    }
    const list = /^(\s*)([-*+]|\d+\.)( .*)?$/.exec(line);
    const head = list === null ? "" : escape(list[1]) + span("number", list[2]);
    const rest = list === null ? line : list[3] || "";
    const parts = rest.split(/(`[^`]*`|\*\*[^*]+\*\*)/);
    return head + parts.map((part) => (part.startsWith("`") ? span("path", part) : part.startsWith("**") ? span("keyword", part) : escape(part))).join("");
  }).join("\n");
}

// ----- bash, for the before-and-after examples -----

const BASH_KEYWORDS = new Set(["for", "in", "do", "done", "if", "then", "elif", "else", "fi", "while", "until", "case", "esac", "function", "return", "local", "export"]);

// one pass with one pattern: a comment (a # at the start or after a space), a quoted string,
// a variable ($x, ${x}, $1, $( ), a number, or a word
const BASH_TOKEN = /((?<=^|\s)#[^\n]*)|('[^']*'|"(?:\\.|[^"\\])*")|(\$\{[^}]*\}|\$\(|\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9@#?*!$-])|(\b\d+\b)|([A-Za-z_][A-Za-z0-9_-]*)/g;

export function highlightBash(code) {
  let out = "";
  let at = 0;
  for (const match of code.matchAll(BASH_TOKEN)) {
    out += escape(code.slice(at, match.index));
    const [text, comment, string, variable, number] = match;
    if (comment !== undefined) {
      out += span("comment", text);
    } else if (string !== undefined) {
      out += span("string", text);
    } else if (variable !== undefined) {
      out += span("path", text);
    } else if (number !== undefined) {
      out += span("number", text);
    } else {
      out += BASH_KEYWORDS.has(text) ? span("keyword", text) : escape(text);
    }
    at = match.index + text.length;
  }
  return out + escape(code.slice(at));
}

export function highlight(code) {
  let out = "";
  let at = 0;
  let previous = null;
  for (const token of tokenize(code)) {
    out += gap(code.slice(at, token.start));
    const text = code.slice(token.start, token.end);
    if (token.type === "word") {
      // the word after git is its operation: git status, git commit
      const isKeyword = KEYWORDS.has(token.value) || (previous !== null && previous.type === "word" && previous.value === "git");
      out += isKeyword ? span("keyword", text) : escape(text);
    } else if (token.type === "string" && /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text)) {
      out += span("path", text);
    } else if (token.type === "string" || token.type === "template") {
      out += span("string", text);
    } else if (token.type === "number") {
      out += span("number", text);
    } else if (token.type === "path") {
      out += span("path", text);
    } else if (token.type === "possessive") {
      out += span("keyword", text);
    } else {
      out += escape(text);
    }
    at = token.end;
    previous = token;
  }
  return out + gap(code.slice(at));
}
