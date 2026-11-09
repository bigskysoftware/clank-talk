// Parser: turns tokens into a syntax tree
//
// The parser does not throw. Each problem becomes an error in the result,
// next to the errors from the tokenizer, so all problems are reported together.
//
// Commands so far:
//   print <expression>
//   if <expression> ... end
//   <tool name>          a call to a tool from AGENTS.talk, with no arguments yet

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

  function isOp(value) {
    const token = current();
    return token !== undefined && token.type === "op" && token.value === value;
  }

  // consume an op, or record an error
  function expectOp(value) {
    if (isOp(value)) {
      i++;
      return true;
    }
    error("Expected '" + value + "'");
    return false;
  }

  // ----- expressions -----
  //
  // A simple recursive descent parser. Each level calls the level below it.
  // From lowest to highest priority:
  //
  //   expression = logic
  //   logic      = comparison ( ("and" | "or") comparison )*
  //   comparison = math ( compare math | check )?
  //   math       = conversion ( ("+" | "-" | "*" | "/" | "mod") conversion )*
  //   conversion = unary ( "as" word )*
  //   unary      = ("not" | "no" | "-") unary | access
  //   access     = primary ( "'s" word | "." word | "[" expression "]" )*
  //   primary    = "the"? ( literal | list | object | "(" expression ")" | it | result | variable )
  //
  // Mixing different math operators, or "and" with "or", needs parentheses.

  const CONVERSIONS = ["json", "number", "text"];

  // symbols give the same operator name as the words
  const SYMBOLS = {
    "==": "is",
    "!=": "is not",
    "<": "is less than",
    ">": "is greater than",
    "<=": "is less than or equal to",
    ">=": "is greater than or equal to",
  };

  function node(type, token, fields) {
    return { type, ...fields, line: token.line, column: token.column };
  }

  function parseExpression() {
    return parseLogic();
  }

  function parseLogic() {
    let left = parseComparison();
    let operator = null;
    while (left !== null && (isWord("and") || isWord("or"))) {
      const token = current();
      if (operator !== null && operator !== token.value) {
        error("Mixing 'and' and 'or' needs parentheses");
        return null;
      }
      operator = token.value;
      i++;
      const right = parseComparison();
      if (right === null) {
        return null;
      }
      left = node("binary", token, { operator, left, right });
    }
    return left;
  }

  // the words after "is": "is", "is not", "is less than", "is in", ...
  // gives the operator name, or null if there is an error
  function parseIsOperator() {
    let operator = "is";
    if (isWord("not")) {
      i++;
      operator = "is not";
    }
    if (operator === "is" && (isWord("less") || isWord("greater"))) {
      operator = "is " + current().value;
      i++;
      if (!isWord("than")) {
        error("Expected 'than'");
        return null;
      }
      i++;
      operator += " than";
      if (isWord("or")) {
        i++;
        if (!isWord("equal")) {
          error("Expected 'equal'");
          return null;
        }
        i++;
        if (!isWord("to")) {
          error("Expected 'to'");
          return null;
        }
        i++;
        operator += " or equal to";
      }
      return operator;
    }
    if (isWord("empty")) {
      i++;
      return operator + " empty";
    }
    if (isWord("in")) {
      i++;
      return operator + " in";
    }
    return operator;
  }

  function parseComparison() {
    const left = parseMath();
    if (left === null) {
      return null;
    }
    const token = current();
    if (token === undefined) {
      return left;
    }

    let operator = null;

    if (token.type === "op" && SYMBOLS[token.value] !== undefined) {
      i++;
      operator = SYMBOLS[token.value];
    } else if (isWord("is")) {
      i++;
      operator = parseIsOperator();
      if (operator === null) {
        return null;
      }
    } else if (isWord("contains")) {
      i++;
      operator = "contains";
    } else if (isWord("exists")) {
      i++;
      operator = "exists";
    } else if (isWord("starts") || isWord("ends")) {
      operator = token.value + " with";
      i++;
      if (!isWord("with")) {
        error("Expected 'with'");
        return null;
      }
      i++;
    } else if (isWord("does")) {
      i++;
      if (!isWord("not")) {
        error("Expected 'not'");
        return null;
      }
      i++;
      if (isWord("contain")) {
        i++;
        operator = "does not contain";
      } else if (isWord("exist")) {
        i++;
        operator = "does not exist";
      } else {
        error("Expected 'contain' or 'exist'");
        return null;
      }
    } else {
      return left;
    }

    // checks have no right side
    if (operator === "exists" || operator === "does not exist" || operator === "is empty" || operator === "is not empty") {
      return node("check", token, { operator, value: left });
    }

    const right = parseMath();
    if (right === null) {
      return null;
    }
    return node("binary", token, { operator, left, right });
  }

  function isMathOperator() {
    return isOp("+") || isOp("-") || isOp("*") || isOp("/") || isWord("mod");
  }

  function parseMath() {
    let left = parseConversion();
    let operator = null;
    while (left !== null && isMathOperator()) {
      const token = current();
      if (operator !== null && operator !== token.value) {
        error("Mixing '" + operator + "' and '" + token.value + "' needs parentheses");
        return null;
      }
      operator = token.value;
      i++;
      const right = parseConversion();
      if (right === null) {
        return null;
      }
      left = node("binary", token, { operator, left, right });
    }
    return left;
  }

  function parseConversion() {
    let value = parseUnary();
    while (value !== null && isWord("as")) {
      const token = current();
      i++;
      const to = current();
      if (to === undefined || to.type !== "word" || !CONVERSIONS.includes(to.value)) {
        error("Expected one of: " + CONVERSIONS.join(", "));
        return null;
      }
      i++;
      value = node("conversion", token, { value, to: to.value });
    }
    return value;
  }

  function parseUnary() {
    const token = current();
    if (isWord("not") || isWord("no") || isOp("-")) {
      i++;
      const value = parseUnary();
      if (value === null) {
        return null;
      }
      return node("unary", token, { operator: token.value, value });
    }
    return parseAccess();
  }

  function parseAccess() {
    let value = parsePrimary();
    while (value !== null) {
      const token = current();
      if (token !== undefined && token.type === "possessive") {
        i++;
        value = parseProperty(value, token);
      } else if (isOp(".")) {
        i++;
        value = parseProperty(value, token);
      } else if (isOp("[")) {
        i++;
        const index = parseExpression();
        if (index === null || !expectOp("]")) {
          return null;
        }
        value = node("index", token, { object: value, index });
      } else {
        break;
      }
    }
    return value;
  }

  // the word after 's or .
  function parseProperty(object, token) {
    const name = current();
    if (name === undefined || name.type !== "word") {
      error("Expected a property name");
      return null;
    }
    i++;
    return node("property", token, { object, name: name.value });
  }

  function parsePrimary() {
    // "the" is optional noise
    if (isWord("the")) {
      i++;
    }

    const token = current();
    if (token === undefined || isCommandStart()) {
      error("Expected a value");
      return null;
    }

    if (token.type === "string") {
      i++;
      return node("string", token, { value: token.value });
    }
    if (token.type === "number") {
      i++;
      return node("number", token, { value: Number(token.value) });
    }
    if (token.type === "path") {
      i++;
      return node("path", token, { value: token.value });
    }
    if (isOp("[")) {
      i++;
      return parseList(token);
    }
    if (isOp("{")) {
      i++;
      return parseObject(token);
    }
    if (isOp("(")) {
      i++;
      const inner = parseExpression();
      if (inner === null || !expectOp(")")) {
        return null;
      }
      return inner;
    }
    if (token.type === "word") {
      i++;
      if (token.value === "true") {
        return node("boolean", token, { value: true });
      }
      if (token.value === "false") {
        return node("boolean", token, { value: false });
      }
      if (token.value === "null") {
        return node("null", token, {});
      }
      if (token.value === "it" || token.value === "result") {
        return node("result", token, {});
      }
      return node("variable", token, { name: token.value });
    }

    error("Expected a value, found '" + token.value + "'");
    return null;
  }

  // [a, b, c], after the "["
  function parseList(token) {
    const items = [];
    if (!isOp("]")) {
      while (true) {
        const item = parseExpression();
        if (item === null) {
          return null;
        }
        items.push(item);
        if (isOp(",")) {
          i++;
          continue;
        }
        break;
      }
    }
    if (!expectOp("]")) {
      return null;
    }
    return node("list", token, { items });
  }

  // {name: value, "other name": value}, after the "{"
  function parseObject(token) {
    const fields = [];
    if (!isOp("}")) {
      while (true) {
        const key = current();
        if (key === undefined || (key.type !== "word" && key.type !== "string")) {
          error("Expected a field name");
          return null;
        }
        i++;
        if (!expectOp(":")) {
          return null;
        }
        const value = parseExpression();
        if (value === null) {
          return null;
        }
        fields.push({ name: key.value, value });
        if (isOp(",")) {
          i++;
          continue;
        }
        break;
      }
    }
    if (!expectOp("}")) {
      return null;
    }
    return node("object", token, { fields });
  }

  // ----- commands -----

  function parsePrint(token) {
    const value = parseExpression();
    return { type: "print", value, line: token.line, column: token.column };
  }

  function parseIf(token) {
    const condition = parseExpression();
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
      const errorCount = errors.length;
      const command = parser(token);
      // if the command had an error, skip the rest of it, so one mistake gives one error
      if (errors.length > errorCount) {
        skipToNextCommand();
      }
      return command;
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
