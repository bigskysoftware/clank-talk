// Tokenizer: turns ClankTalk source text into a flat list of tokens
//
// The tokenizer does not know about keywords. "if", "set" and "file" are all
// words. The parser decides what a word means.

/**
 * @typedef {Object} Token
 * @property {string} type    word, string, number, path, possessive or op
 * @property {string} value   the text of the token (strings without quotes)
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

  function error(message) {
    return new Error(message + " at line " + line + ", column " + column);
  }

  while (i < source.length) {
    const c = source[i];
    const startLine = line;
    const startColumn = column;

    function push(type, value) {
      tokens.push({ type, value, line: startLine, column: startColumn });
    }

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
      push("possessive", "'s");
      continue;
    }

    // string: '...' or "..."
    if (c === "'" || c === '"') {
      const quote = c;
      let value = "";
      advance();
      while (true) {
        if (i >= source.length || source[i] === "\n") {
          throw error("Unterminated string");
        }
        if (source[i] === quote) {
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
      push("string", value);
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
        while (source[i] !== '"') {
          if (i >= source.length || source[i] === "\n") {
            throw error("Unterminated path");
          }
          value += source[i];
          advance();
        }
        advance();
      } else {
        while (i < source.length && !isSpace(source[i]) && source[i] !== ")" && source[i] !== ",") {
          value += source[i];
          advance();
        }
      }
      push("path", value);
      continue;
    }

    // number: 12, 3.5, 1_000, -3
    // "-" is part of the number only if a digit follows and it does not touch the token before it,
    // so "x - 3" and "x-3" are subtraction, and "set x to -3" is a negative number
    const negative = c === "-" && isDigit(source[i + 1] || "") && (prev === undefined || isSpace(prev) || prev === "(" || prev === ",");
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
      push("number", value);
      continue;
    }

    // word
    if (isLetter(c)) {
      let value = "";
      while (i < source.length && isWordChar(source[i])) {
        value += source[i];
        advance();
      }
      push("word", value);
      continue;
    }

    // operator: a single character
    if (OP_CHARS.includes(c)) {
      advance();
      push("op", c);
      continue;
    }

    throw error("Unexpected character '" + c + "'");
  }

  return tokens;
}
