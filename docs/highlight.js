// Build-time syntax highlighter for ```talk code blocks
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
