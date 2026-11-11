// Tokenizer: turns ClankTalk source text into a flat list of tokens
//
// The tokenizer does not know about keywords. "if", "set" and "file" are all
// words. The parser decides what a word means.
//
// Problems do not stop the tokenizer. A problem becomes an "error" token, and
// the tokenizer keeps going, so all problems can be reported together later.

/**
 * @typedef {Object} Token
 * @property {string} type    word, string, template, number, path, possessive, op or error
 * @property {string|Array} value   the text of the token (strings without quotes), the error message,
 *                                  or for a template: parts that are text or token lists
 * @property {number} line    1-based line of the first character
 * @property {number} column  1-based column of the first character
 */

const OP_CHARS = "()[]{},.:+-*/=<>!";

function isLetter(c) {
  return /[A-Za-z_]/.test(c);
}

function isWordChar(c) {
  return /[A-Za-z0-9_]/.test(c);
}

function isDigit(c) {
  return /[0-9]/.test(c);
}

function isSpace(c) {
  return c === " " || c === "\t" || c === "\r" || c === "\n";
}

// only spaces or tabs come before position j on its line
function atLineStart(text, j) {
  let k = j - 1;
  while (k >= 0 && (text[k] === " " || text[k] === "\t")) {
    k--;
  }
  return k < 0 || text[k] === "\n";
}

// true if the ' at index j is the 's of a possessive: it touches a word, "]", "}" or ")", and no word character follows the s
function isPossessive(text, j) {
  const prev = text[j - 1];
  if (text[j + 1] !== "s" || prev === undefined || isWordChar(text[j + 2] || " ")) {
    return false;
  }
  return isWordChar(prev) || prev === "]" || prev === "}" || prev === ")";
}

// index of the "}" that closes a "${", or -1
// start is the index just after the "${"
// braces inside the expression nest, and quoted text inside it is skipped
function findTemplateEnd(text, start) {
  let depth = 0;
  let j = start;
  while (j < text.length) {
    const ch = text[j];
    // the 's in x's is a possessive, not a quote
    if (ch === "'" && isPossessive(text, j)) {
      j += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      j++;
      while (j < text.length && text[j] !== ch) {
        if (text[j] === "\\") {
          j++;
        }
        j++;
      }
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      if (depth === 0) {
        return j;
      }
      depth--;
    }
    j++;
  }
  return -1;
}

// for text with line breaks: drop a line break right after the opening quote,
// make a last line of only spaces empty, and remove the indent that all
// non-blank lines share
function removeIndent(raw) {
  if (!raw.includes("\n")) {
    return raw;
  }
  const lines = raw.split("\n");
  if (lines[0].trim() === "") {
    lines.shift();
  }
  if (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines[lines.length - 1] = "";
  }

  let indent = null;
  for (const line of lines) {
    if (line.trim() === "") {
      continue;
    }
    const spaces = line.length - line.trimStart().length;
    if (indent === null || spaces < indent) {
      indent = spaces;
    }
  }

  const result = [];
  for (const line of lines) {
    if (line.trim() === "") {
      result.push("");
    } else {
      result.push(line.slice(indent));
    }
  }
  return result.join("\n");
}

// ${} inside ${} can nest this deep; the parser has the same cap for expressions
const MAX_TEMPLATE_DEPTH = 100;
let templateDepth = 0;

function nestedTokens(source) {
  templateDepth++;
  try {
    return tokenize(source);
  } finally {
    templateDepth--;
  }
}

function tooDeep(line, column) {
  return { type: "error", value: "The script nests more than " + MAX_TEMPLATE_DEPTH + " levels deep. Use variables for parts of it", line, column };
}

// every token, and the parts of a template token, get this position
function placeAt(tokens, line, column) {
  return tokens.map((t) => ({ ...t, line, column, value: t.type === "template" ? t.value.map((part) => typeof part === "string" ? part : placeAt(part, line, column)) : t.value }));
}

// turn raw string text into parts: plain text, and token lists for each ${...}
// escapes: \n, \t, and \x gives x, so \${ gives a plain ${
function splitTemplate(raw, line, column) {
  const parts = [];
  let text = "";
  let j = 0;
  while (j < raw.length) {
    if (raw[j] === "\\" && j + 1 < raw.length) {
      const escaped = raw[j + 1];
      if (escaped === "n") {
        text += "\n";
      } else if (escaped === "t") {
        text += "\t";
      } else {
        text += escaped;
      }
      j += 2;
      continue;
    }
    if (raw.startsWith("${", j)) {
      const end = findTemplateEnd(raw, j + 2);
      if (text !== "") {
        parts.push(text);
        text = "";
      }
      // errors in the expression point at the start of the string, also in a template inside it
      parts.push(templateDepth >= MAX_TEMPLATE_DEPTH ? [tooDeep(line, column)] : placeAt(nestedTokens(raw.slice(j + 2, end)), line, column));
      j = end + 1;
      continue;
    }
    text += raw[j];
    j++;
  }
  if (text !== "") {
    parts.push(text);
  }
  return parts;
}

/**
 * @param {string} source
 * @returns {Token[]}
 */
export function tokenize(source) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let column = 1;

  // move forward one character, keeping line and column up to date
  function advance() {
    if (source[i] === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
    i++;
  }

  // digits with optional _ separators, the _ is dropped: 1_000 gives 1000
  function readDigits() {
    let digits = "";
    while (i < source.length && (isDigit(source[i]) || (source[i] === "_" && isDigit(source[i + 1] || "")))) {
      if (source[i] !== "_") {
        digits += source[i];
      }
      advance();
    }
    return digits;
  }
  // the rest of an unquoted path or url: it ends at whitespace, ")", a "," outside braces, an unmatched "]" or "}",
  // or a possessive 's; a "[" or "{" in it is part of a glob, so only an unmatched "]" or "}" ends it,
  // and a "," inside braces stays: @/src/**/*.{js,md}
  // pathOpen is true after a path that ends with a "[" or "{" still open
  let pathOpen = false;
  function readPathRest() {
    let value = "";
    let depth = 0;
    while (i < source.length && !isSpace(source[i]) && source[i] !== ")" && !(source[i] === "'" && isPossessive(source, i))) {
      if (source[i] === "," && depth === 0) {
        break;
      }
      if (source[i] === "[" || source[i] === "{") {
        depth++;
      }
      if (source[i] === "]" || source[i] === "}") {
        if (depth === 0) {
          break;
        }
        depth--;
      }
      value += source[i];
      advance();
    }
    pathOpen = depth > 0;
    return value;
  }

  // start and end are offsets in the source, so tools such as the site highlighter can find the token's text
  let tokenStart = 0;
  function push(type, value, startLine, startColumn) {
    tokens.push({ type, value, line: startLine, column: startColumn, start: tokenStart, end: i });
  }

  while (i < source.length) {
    const c = source[i];
    const startLine = line;
    const startColumn = column;
    tokenStart = i;

    // whitespace
    if (isSpace(c)) {
      advance();
      continue;
    }

    // comment: # to the end of the line
    if (c === "#") {
      while (i < source.length && source[i] !== "\n") {
        advance();
      }
      continue;
    }

    // text block: lines that start with |; see src/md/features/language.md
    // spaces before the | are ignored, and one space after it is dropped; the rest of the line is the text,
    // exactly as typed; the lines join with line breaks, and the block ends at a line that does not start with |
    if (c === "|" && atLineStart(source, i)) {
      const lines = [];
      while (true) {
        advance();
        if (source[i] === " ") {
          advance();
        }
        let text = "";
        while (i < source.length && source[i] !== "\n") {
          text += source[i];
          advance();
        }
        lines.push(text.endsWith("\r") ? text.slice(0, -1) : text);
        // the next line: spaces, then a | to go on
        let next = i + 1;
        while (next < source.length && (source[next] === " " || source[next] === "\t")) {
          next++;
        }
        if (i >= source.length || source[next] !== "|") {
          break;
        }
        while (i < next) {
          advance();
        }
      }
      push("string", lines.join("\n"), startLine, startColumn);
      continue;
    }

    // a regex right after the word pattern: pattern /test\(/i; see src/md/features/language.md
    // the text between the slashes is raw: no escapes of the string and no templates; a / inside is \/
    // it ends at the first / that has no backslash before it and is not in [...]; flags i, m, s may follow
    const last = tokens[tokens.length - 1];
    if (c === "/" && last !== undefined && last.type === "word" && last.value === "pattern" && last.line === line) {
      advance();
      let text = "";
      let inClass = false;
      let closed = false;
      while (i < source.length && source[i] !== "\n") {
        const ch = source[i];
        if (ch === "\\" && i + 1 < source.length && source[i + 1] !== "\n") {
          text += ch + source[i + 1];
          advance();
          advance();
          continue;
        }
        if (ch === "[") {
          inClass = true;
        } else if (ch === "]") {
          inClass = false;
        } else if (ch === "/" && !inClass) {
          advance();
          closed = true;
          break;
        }
        text += ch;
        advance();
      }
      if (!closed) {
        push("error", "Unterminated pattern: a /regex/ needs a / at its end, on the same line", startLine, startColumn);
        continue;
      }
      let flags = "";
      while (i < source.length && isWordChar(source[i])) {
        flags += source[i];
        advance();
      }
      if (!/^(?!.*(.).*\1)[ims]*$/.test(flags)) {
        push("error", "A pattern takes only the flags i, m and s, once each, found " + flags, startLine, startColumn);
        continue;
      }
      push("regex", { source: text, flags }, startLine, startColumn);
      continue;
    }

    // possessive: the 's in file's
    // it must touch the word before it, and must not be followed by a word character
    const prev = source[i - 1];
    if (c === "'" && isPossessive(source, i)) {
      advance();
      advance();
      push("possessive", "'s", startLine, startColumn);
      continue;
    }

    // raw string: """...""" has no escapes, no ${} and no indent removal
    // only a line break right after the opening quotes is dropped
    // it can open with more quotes, and then ends at the same count, so it can hold three quotes
    if (source.startsWith('"""', i)) {
      let fence = "";
      while (source[i] === '"') {
        fence += '"';
        advance();
      }
      let value = "";
      let closed = false;
      while (i < source.length) {
        // in a run of quotes, the last ones close the string, so the text can end with a quote
        if (source.startsWith(fence, i)) {
          let run = 0;
          while (source[i + run] === '"') {
            run++;
          }
          value += '"'.repeat(run - fence.length);
          for (let n = 0; n < run; n++) {
            advance();
          }
          closed = true;
          break;
        }
        value += source[i];
        advance();
      }
      if (!closed) {
        // four or more quotes open a longer fence, so text that starts with a quote needs a line break first
        const needs = fence.length === 3 ? "Unterminated raw string" : "Unterminated raw string: it opens with " + fence.length + " quotes, so it ends at " + fence.length + " quotes. For text that starts with a quote, put a line break right after the three opening quotes";
        push("error", needs, startLine, startColumn);
        continue;
      }
      if (value.startsWith("\r\n")) {
        value = value.slice(2);
      } else if (value.startsWith("\n")) {
        value = value.slice(1);
      }
      push("string", value, startLine, startColumn);
      continue;
    }

    // string: '...' or "..."
    // a string can span lines, and ${...} in it is a template expression
    if (c === "'" || c === '"') {
      const quote = c;
      let raw = "";
      let closed = false;
      advance();
      while (i < source.length) {
        if (source[i] === quote) {
          closed = true;
          advance();
          break;
        }
        // keep escapes as they are for now, so an escaped quote does not end the string
        if (source[i] === "\\" && i + 1 < source.length) {
          raw += source[i];
          advance();
          raw += source[i];
          advance();
          continue;
        }
        // copy a whole ${...}, so quotes inside it do not end the string
        if (source.startsWith("${", i)) {
          const end = findTemplateEnd(source, i + 2);
          if (end === -1) {
            break;
          }
          while (i <= end) {
            raw += source[i];
            advance();
          }
          continue;
        }
        raw += source[i];
        advance();
      }
      // a string with no closing quote takes the rest of the source
      if (!closed) {
        while (i < source.length) {
          advance();
        }
        push("error", "Unterminated string", startLine, startColumn);
        continue;
      }

      // a script with CRLF line breaks gives LF in a string, as | blocks and raw strings do
      const parts = splitTemplate(removeIndent(raw.replaceAll("\r\n", "\n")), startLine, startColumn);
      if (parts.length === 1 && typeof parts[0] === "string") {
        push("string", parts[0], startLine, startColumn);
      } else if (parts.length === 0) {
        push("string", "", startLine, startColumn);
      } else {
        push("template", parts, startLine, startColumn);
      }
      continue;
    }

    // url: https://example.com/a?b=1, as approved: <word>:// and then the path rules
    // it is a string value, so fetch and print use it as text
    if (!isWordChar(prev || " ") && /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(source.slice(i, i + 40))) {
      let value = "";
      while (source[i] !== ":") {
        value += source[i];
        advance();
      }
      value += "://";
      advance();
      advance();
      advance();
      value += readPathRest();
      push("string", value, startLine, startColumn);
      continue;
    }

    // path: ./foo and ../foo are relative to the current directory, @/foo to the project root
    // a path ends at whitespace, ")", ",", an unmatched "]" or "}", or a possessive 's
    // ./"my file.txt" puts the rest of the path in double quotes, so it can hold those characters
    if (source.startsWith("./", i) || source.startsWith("../", i) || source.startsWith("@/", i)) {
      let value = "";
      while (source[i] !== "/") {
        value += source[i];
        advance();
      }
      value += "/";
      advance();

      if (source[i] === '"') {
        advance();
        while (i < source.length && source[i] !== '"' && source[i] !== "\n") {
          value += source[i];
          advance();
        }
        if (source[i] !== '"') {
          push("error", "Unterminated path", startLine, startColumn);
          continue;
        }
        advance();
        // the path goes on after its quoted part: ./"my dir"/a.txt
        if (source[i] === "/") {
          value += readPathRest();
          if (pathOpen) {
            push("error", "Unclosed { or [ in a path: " + value, startLine, startColumn);
            continue;
          }
        }
      } else {
        value += readPathRest();
        if (pathOpen) {
          push("error", "Unclosed { or [ in a path: " + value, startLine, startColumn);
          continue;
        }
      }
      push("path", value, startLine, startColumn);
      continue;
    }

    // number: 12, 3.5, 1_000, -3
    // "-" is part of the number only if a digit follows and it comes after
    // the start, whitespace or one of ( [ { , = :
    // so "x - 3" and "x-3" are subtraction, and "set x to -3" and "[-1]" are negative numbers
    const negative = c === "-" && isDigit(source[i + 1] || "") && (prev === undefined || isSpace(prev) || "([{,=:".includes(prev));
    if (isDigit(c) || negative) {
      let value = "";
      if (negative) {
        value += "-";
        advance();
      }
      value += readDigits();
      if (source[i] === "." && isDigit(source[i + 1] || "")) {
        value += ".";
        advance();
        value += readDigits();
      }
      push("number", value, startLine, startColumn);
      continue;
    }

    // word, or a global variable: $name
    if (isLetter(c) || (c === "$" && isLetter(source[i + 1] || ""))) {
      let value = "";
      if (c === "$") {
        value += "$";
        advance();
      }
      // a hyphen joins a word when a letter comes right after it: build-dir, content-type
      // n-1 stays subtraction, and so does a - b
      while (i < source.length && (isWordChar(source[i]) || (source[i] === "-" && /[A-Za-z]/.test(source[i + 1] || "")))) {
        value += source[i];
        advance();
      }
      push("word", value, startLine, startColumn);
      continue;
    }

    // operator: == != <= >= are two characters, all others are one
    const two = source.slice(i, i + 2);
    if (two === "==" || two === "!=" || two === "<=" || two === ">=") {
      advance();
      advance();
      push("op", two, startLine, startColumn);
      continue;
    }
    if (OP_CHARS.includes(c)) {
      advance();
      push("op", c, startLine, startColumn);
      continue;
    }

    // anything else: record it and skip the character; an emoji is two UTF-16 units, but one character
    const char = String.fromCodePoint(source.codePointAt(i));
    for (let k = 0; k < char.length; k++) {
      advance();
    }
    push("error", "Unexpected character '" + char + "'", startLine, startColumn);
  }

  return tokens;
}
