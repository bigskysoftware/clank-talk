// Tokenizer: turns ClankTalk source text into a flat list of tokens
//
// The tokenizer does not know about keywords. "if", "set" and "file" are all
// words. The parser decides what a word means.
//
// Problems do not stop the tokenizer. A problem becomes an "error" token, and
// the tokenizer keeps going, so all problems can be reported together later.

/**
 * @typedef {Object} Token
 * @property {string} type    word, string, number, path, possessive, op or error
 * @property {string} value   the text of the token (strings without quotes), or the error message
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
    if (c === "'" && source[i + 1] === "s" && prev !== undefined && isWordChar(prev) && !isWordChar(source[i + 2] || " ")) {
      advance();
      advance();
      push("possessive", "'s", startLine, startColumn);
      continue;
    }

    // string: '...' or "..."
    if (c === "'" || c === '"') {
      const quote = c;
      let value = "";
      let closed = false;
      advance();
      while (true) {
        if (i >= source.length || source[i] === "\n") {
          break;
        }
        if (source[i] === quote) {
          closed = true;
          advance();
          break;
        }
        if (source[i] === "\\") {
          advance();
          const escaped = source[i];
          if (escaped === "n") {
            value += "\n";
          } else if (escaped === "t") {
            value += "\t";
          } else {
            value += escaped;
          }
          advance();
          continue;
        }
        value += source[i];
        advance();
      }
      if (closed) {
        push("string", value, startLine, startColumn);
      } else {
        push("error", "Unterminated string", startLine, startColumn);
      }
      continue;
    }

    // path: ./foo and ../foo are relative to the current directory, @/foo to the project root
    // a path ends at whitespace, ")" or ","
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
        while (i < source.length && !isSpace(source[i]) && source[i] !== ")" && source[i] !== ",") {
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
