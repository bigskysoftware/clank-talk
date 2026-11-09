// Parser: turns tokens into a syntax tree
//
// The parser does not throw. Each problem becomes an error in the result,
// next to the errors from the tokenizer, so all problems are reported together.
//
// This first version knows only:
//   print <value>
//   if <value> ... end
//   <tool name>          a call to a tool from AGENTS.talk, with no arguments yet
// and a <value> is only a string, number, path or variable.

import { tokenize } from "./tokenizer.js";

/**
 * @typedef {Object} ParseError
 * @property {string} message
 * @property {number} line
 * @property {number} column
 */

/**
 * @param {string} source
 * @param {Object} [options]
 * @param {string[]} [options.tools]  names of the tools in AGENTS.talk
 * @returns {{ script: Object, errors: ParseError[] }}
 */
export function parse(source, options = {}) {
  const tools = options.tools || [];
  const errors = [];

  // tokenizer errors are reported, and then left out of the token list
  const tokens = [];
  for (const token of tokenize(source)) {
    if (token.type === "error") {
      errors.push({ message: token.value, line: token.line, column: token.column });
    } else {
      tokens.push(token);
    }
  }

  let i = 0;

  // ----- token helpers -----

  function current() {
    return tokens[i];
  }

  function atEnd() {
    return i >= tokens.length;
  }

  function isWord(value) {
    const token = current();
    return token !== undefined && token.type === "word" && token.value === value;
  }

  // the position of the current token, or of the last token at the end of the source
  function position() {
    const token = current() || tokens[tokens.length - 1] || { line: 1, column: 1 };
    return { line: token.line, column: token.column };
  }

  function error(message) {
    const where = position();
    errors.push({ message, line: where.line, column: where.column });
  }

  // after an error, skip tokens up to the start of the next command
  function skipToNextCommand() {
    while (!atEnd() && !isCommandStart()) {
      i++;
    }
  }

  function isCommandStart() {
    const token = current();
    if (token === undefined || token.type !== "word") {
      return false;
    }
    return COMMANDS[token.value] !== undefined || token.value === "end" || token.value === "then";
  }

  // ----- values -----

  function parseValue() {
    const token = current();
    if (token === undefined || isCommandStart()) {
      error("Expected a value");
      return null;
    }
    if (token.type === "string") {
      i++;
      return { type: "string", value: token.value, line: token.line, column: token.column };
    }
    if (token.type === "number") {
      i++;
      return { type: "number", value: Number(token.value), line: token.line, column: token.column };
    }
    if (token.type === "path") {
      i++;
      return { type: "path", value: token.value, line: token.line, column: token.column };
    }
    if (token.type === "word") {
      i++;
      return { type: "variable", name: token.value, line: token.line, column: token.column };
    }
    error("Expected a value, found '" + token.value + "'");
    return null;
  }

  // ----- commands -----

  function parsePrint(token) {
    const value = parseValue();
    return { type: "print", value, line: token.line, column: token.column };
  }

  function parseIf(token) {
    const condition = parseValue();
    const body = parseCommands();
    if (isWord("end")) {
      i++;
    } else {
      error("Expected 'end' for the 'if' at line " + token.line);
    }
    return { type: "if", condition, body, line: token.line, column: token.column };
  }

  // each command parser gets the command token, after it is consumed
  const COMMANDS = {
    print: parsePrint,
    if: parseIf,
  };

  // one command, or null if there is an error
  function parseCommand() {
    const token = current();

    if (token.type !== "word") {
      error("Expected a command, found '" + token.value + "'");
      i++;
      skipToNextCommand();
      return null;
    }

    const parser = COMMANDS[token.value];
    if (parser !== undefined) {
      i++;
      return parser(token);
    }

    if (tools.includes(token.value)) {
      i++;
      return { type: "toolCall", name: token.value, line: token.line, column: token.column };
    }

    error("Unknown command '" + token.value + "'");
    i++;
    skipToNextCommand();
    return null;
  }

  // commands up to an 'end' or the end of the source
  // 'then' between commands is skipped
  function parseCommands() {
    const commands = [];
    while (!atEnd() && !isWord("end")) {
      if (isWord("then")) {
        i++;
        continue;
      }
      const command = parseCommand();
      if (command !== null) {
        commands.push(command);
      }
    }
    return commands;
  }

  // ----- script -----

  const commands = parseCommands();
  while (!atEnd()) {
    // only a stray 'end' can stop parseCommands before the end of the source
    error("Unexpected 'end'");
    i++;
    commands.push(...parseCommands());
  }

  return { script: { type: "script", commands }, errors };
}
