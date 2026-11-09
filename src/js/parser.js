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
  function withoutErrors(list) {
    const result = [];
    for (const token of list) {
      if (token.type === "error") {
        errors.push({ message: token.value, line: token.line, column: token.column });
      } else {
        result.push(token);
      }
    }
    return result;
  }

  // "let", because a template expression parses its own token list for a moment
  let tokens = withoutErrors(tokenize(source));

  let i = 0;

  // how many loops the parser is inside, for break and continue
  let loopDepth = 0;

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

    // read as an expression: set readme to read @/README.md
    if (isWord("read")) {
      const readToken = current();
      i++;
      // only a value with access, so "read ./a.txt + 'x'" reads ./a.txt, then adds 'x'
      const file = parseAccess();
      if (file === null) {
        return null;
      }
      return node("read", readToken, { file });
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
    if (token.type === "template") {
      i++;
      return parseTemplate(token);
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

  // 'Hi ${name}': the parts are text, or token lists from the tokenizer
  // each token list is parsed as an expression, with the parser pointed at it for a moment
  function parseTemplate(token) {
    const parts = [];
    for (const part of token.value) {
      if (typeof part === "string") {
        parts.push(part);
        continue;
      }
      const savedTokens = tokens;
      const savedIndex = i;
      tokens = withoutErrors(part);
      i = 0;
      let expression = null;
      if (tokens.length === 0) {
        errors.push({ message: "Empty ${} in a string", line: token.line, column: token.column });
      } else {
        expression = parseExpression();
        if (expression !== null && !atEnd()) {
          error("Unexpected '" + current().value + "' in ${}");
          expression = null;
        }
      }
      tokens = savedTokens;
      i = savedIndex;
      if (expression === null) {
        return null;
      }
      parts.push(expression);
    }
    return node("template", token, { parts });
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
    const body = parseBody(token);
    return { type: "if", condition, body, line: token.line, column: token.column };
  }

  // commands up to the "end" of a block, and the "end" itself
  function parseBody(token) {
    const body = parseCommands();
    if (isWord("end")) {
      i++;
    } else {
      error("Expected 'end' for the '" + token.value + "' at line " + token.line);
    }
    return body;
  }

  // a loop body: like parseBody, but break and continue are allowed in it
  function parseLoopBody(token) {
    loopDepth++;
    const body = parseBody(token);
    loopDepth--;
    return body;
  }

  // a variable name, for "for x" and "index i"
  function parseName() {
    const token = current();
    if (token === undefined || token.type !== "word") {
      error("Expected a variable name");
      return null;
    }
    i++;
    return token.value;
  }

  // optional "index i" or "with index i" after a loop header
  // gives the name, or null if there is no index, or undefined if there is an error
  function parseIndex() {
    if (isWord("with")) {
      i++;
      if (!isWord("index")) {
        error("Expected 'index'");
        return undefined;
      }
    }
    if (!isWord("index")) {
      return null;
    }
    i++;
    const name = parseName();
    if (name === null) {
      return undefined;
    }
    return name;
  }

  // for <name> in <expression> [with] [index <name>] ... end
  function parseFor(token) {
    const name = parseName();
    if (name === null) {
      return null;
    }
    if (!isWord("in")) {
      error("Expected 'in'");
      return null;
    }
    i++;
    const list = parseExpression();
    if (list === null) {
      return null;
    }
    const index = parseIndex();
    if (index === undefined) {
      return null;
    }
    const body = parseLoopBody(token);
    return { type: "for", name, list, index, body, line: token.line, column: token.column };
  }

  // repeat <expression> times ... end
  // repeat while <expression> ... end
  // repeat until <expression> ... end
  // each can have [with] index <name>
  function parseRepeat(token) {
    let kind = "times";
    if (isWord("while") || isWord("until")) {
      kind = current().value;
      i++;
    }
    const value = parseExpression();
    if (value === null) {
      return null;
    }
    if (kind === "times") {
      if (!isWord("times")) {
        error("Expected 'times', 'while' or 'until'");
        return null;
      }
      i++;
    }
    const index = parseIndex();
    if (index === undefined) {
      return null;
    }
    const body = parseLoopBody(token);
    return { type: "repeat", kind, value, index, body, line: token.line, column: token.column };
  }

  // break and continue, only inside a loop
  function parseLoopControl(token) {
    if (loopDepth === 0) {
      errors.push({ message: "'" + token.value + "' is only allowed in a loop", line: token.line, column: token.column });
      return null;
    }
    return { type: token.value, line: token.line, column: token.column };
  }

  // read <expression>: puts the text of a file in the result
  function parseRead(token) {
    const file = parseAccess();
    return { type: "read", file, line: token.line, column: token.column };
  }

  // set <target> to <expression>
  // the target is a variable, a property (x's y, x.y) or an index (x[0])
  function parseSet(token) {
    const target = parseTarget();
    if (target === null) {
      return null;
    }
    if (!isWord("to")) {
      error("Expected 'to'");
      return null;
    }
    i++;
    const value = parseExpression();
    return { type: "set", target, value, line: token.line, column: token.column };
  }

  // increment <target> [by <expression>]
  // decrement <target> [by <expression>]
  // with no "by", the amount is 1
  function parseIncrement(token) {
    const target = parseTarget();
    if (target === null) {
      return null;
    }
    let amount = { type: "number", value: 1, line: token.line, column: token.column };
    if (isWord("by")) {
      i++;
      amount = parseExpression();
    }
    return { type: token.value, target, amount, line: token.line, column: token.column };
  }

  function parseTarget() {
    const start = current() || { line: 0, column: 0 };
    const target = parseAccess();
    if (target === null) {
      return null;
    }
    if (target.type !== "variable" && target.type !== "property" && target.type !== "index") {
      errors.push({ message: "Cannot set this, expected a variable or a property", line: start.line, column: start.column });
      return null;
    }
    return target;
  }

  // each command parser gets the command token, after it is consumed
  const COMMANDS = {
    print: parsePrint,
    if: parseIf,
    read: parseRead,
    set: parseSet,
    increment: parseIncrement,
    decrement: parseIncrement,
    for: parseFor,
    repeat: parseRepeat,
    break: parseLoopControl,
    continue: parseLoopControl,
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
