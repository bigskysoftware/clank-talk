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
      // errors in the expression point at the start of the string
      const tokens = tokenize(raw.slice(j + 2, end)).map((t) => ({ ...t, line, column }));
      parts.push(tokens);
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

  function push(type, value, startLine, startColumn) {
    tokens.push({ type, value, line: startLine, column: startColumn });
  }

  while (i < source.length) {
    const c = source[i];
    const startLine = line;
    const startColumn = column;

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
    if (source.startsWith('"""', i)) {
      advance();
      advance();
      advance();
      let value = "";
      let closed = false;
      while (i < source.length) {
        if (source.startsWith('"""', i)) {
          advance();
          advance();
          advance();
          closed = true;
          break;
        }
        value += source[i];
        advance();
      }
      if (!closed) {
        push("error", "Unterminated raw string", startLine, startColumn);
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

      const parts = splitTemplate(removeIndent(raw), startLine, startColumn);
      if (parts.length === 1 && typeof parts[0] === "string") {
        push("string", parts[0], startLine, startColumn);
      } else if (parts.length === 0) {
        push("string", "", startLine, startColumn);
      } else {
        push("template", parts, startLine, startColumn);
      }
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
      } else {
        // a "[" or "{" in a path is part of a glob, so only an unmatched "]" or "}" ends the path
        let depth = 0;
        while (i < source.length && !isSpace(source[i]) && source[i] !== ")" && source[i] !== "," && !(source[i] === "'" && isPossessive(source, i))) {
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
      while (i < source.length && isWordChar(source[i])) {
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

    // anything else: record it and skip the character
    advance();
    push("error", "Unexpected character '" + c + "'", startLine, startColumn);
  }

  return tokens;
}
