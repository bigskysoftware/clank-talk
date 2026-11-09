// Build-time syntax highlighter for ```talk code blocks
// Plodding char-by-char scan: comments, strings, numbers, paths, keywords

const KEYWORDS = [
  // commands
  "print", "set", "increment", "decrement", "if", "else", "end", "then",
  "for", "in", "index", "repeat", "times", "while", "until", "break", "continue",
  "read", "write", "append", "replace", "with", "to", "by",
  "tool", "import", "run", "fetch", "ask", "before", "after", "reject", "undo", "on", "error",
  // expressions
  "the", "it", "result", "true", "false", "null", "not", "no", "and", "or", "mod",
  "is", "less", "greater", "than", "equal", "contains", "does", "contain", "starts", "ends",
  "exists", "exist", "empty", "as", "json", "pretty",
  // site examples that are not built yet
  "last", "steps",
];

function escape(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function span(cls, text) {
  return '<span class="tok-' + cls + '">' + escape(text) + "</span>";
}

function isWordStart(c) {
  return /[A-Za-z_]/.test(c);
}

function isWordChar(c) {
  return /[A-Za-z0-9_]/.test(c);
}

function isDigit(c) {
  return /[0-9]/.test(c);
}

export function highlight(code) {
  let out = "";
  let i = 0;

  while (i < code.length) {
    const c = code[i];

    // comment: # to end of line
    if (c === "#") {
      let j = code.indexOf("\n", i);
      if (j === -1) {
        j = code.length;
      }
      out += span("comment", code.slice(i, j));
      i = j;
      continue;
    }

    // path literal: ./foo, ../foo or @/foo, up to whitespace
    if (code.startsWith("./", i) || code.startsWith("../", i) || code.startsWith("@/", i)) {
      let j = i;
      while (j < code.length && !/\s/.test(code[j])) {
        j++;
      }
      out += span("path", code.slice(i, j));
      i = j;
      continue;
    }

    // string: "..." or '...'
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < code.length && code[j] !== c && code[j] !== "\n") {
        j++;
      }
      if (code[j] === c) {
        j++;
      }
      out += span("string", code.slice(i, j));
      i = j;
      continue;
    }

    // number
    if (isDigit(c)) {
      let j = i;
      while (j < code.length && isDigit(code[j])) {
        j++;
      }
      out += span("number", code.slice(i, j));
      i = j;
      continue;
    }

    // word: keyword or plain
    if (isWordStart(c)) {
      let j = i;
      while (j < code.length && isWordChar(code[j])) {
        j++;
      }
      const word = code.slice(i, j);
      if (KEYWORDS.includes(word)) {
        out += span("keyword", word);
      } else {
        out += escape(word);
      }
      i = j;

      // possessive: file's
      if (code.startsWith("'s", i) && !isWordChar(code[i + 2] || " ")) {
        out += span("keyword", "'s");
        i = i + 2;
      }
      continue;
    }

    // anything else
    out += escape(c);
    i++;
  }

  return out;
}
