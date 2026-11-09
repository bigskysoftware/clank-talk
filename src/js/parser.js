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
// the words after "git"; see src/md/features/git.md
export const GIT_OPERATIONS = ["status", "diff", "log", "show", "branches", "branch", "switch", "commit", "merge", "push", "delete"];

/**
 * @typedef {Object} ParseError
 * @property {string} message
 * @property {number} line
 * @property {number} column
 */

/**
 * @param {string} source
 * @param {Object} [options]
 * @param {string[]} [options.tools]        names of the tools in AGENTS.talk
 * @param {boolean} [options.definitions]   true for AGENTS.talk: only definitions at the top level
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

  // the follows set: words that a command claims, so an expression stops before them
  let follows = [];

  // how many loops the parser is inside, for break and continue
  let loopDepth = 0;

  // true while the parser is inside a tool definition, where "run" is allowed
  let inTool = false;

  // "before" or "after" while the parser is inside a hook, else null
  let inHook = null;

  // blocks the parser is inside (if, loops, tool bodies), to keep "on error" at the top level
  let blockDepth = 0;

  // "on error": seen once in this script or tool, and inside one now
  let handlerSeen = false;
  let inHandler = false;

  // ----- token helpers -----

  function current() {
    return tokens[i];
  }

  function atEnd() {
    return i >= tokens.length;
  }

  // a claimed word is never taken by an expression; see parseBefore
  function isWord(value) {
    const token = current();
    if (follows.includes(value)) {
      return false;
    }
    return token !== undefined && token.type === "word" && token.value === value;
  }

  // parse an expression that must stop before the claimed words, as in hyperscript:
  // in "lines a to b of f", "b of f" is not a property, because "of" is claimed
  // the command checks its own word after the claims are gone
  function parseBefore(words, parse) {
    const saved = follows;
    follows = follows.concat(words);
    try {
      return parse();
    } finally {
      follows = saved;
    }
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
    follows = [];
    while (!atEnd() && !isCommandStart()) {
      i++;
    }
  }

  function isCommandStart() {
    const token = current();
    if (token === undefined || token.type !== "word") {
      return false;
    }
    return COMMANDS[token.value] !== undefined || token.value === "end" || token.value === "else" || token.value === "then";
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
      // "as pretty json" is two words
      let pretty = false;
      if (isWord("pretty")) {
        pretty = true;
        i++;
      }
      const to = current();
      if (to === undefined || to.type !== "word" || !CONVERSIONS.includes(to.value) || (pretty && to.value !== "json")) {
        error("Expected one of: " + CONVERSIONS.join(", ") + ", pretty json");
        return null;
      }
      i++;
      value = node("conversion", token, { value, to: pretty ? "pretty json" : to.value });
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
    // after "the", a word is always a value, even a command word: the write's path
    if (isWord("the")) {
      i++;
      const next = current();
      // the undo list: the scripts that undo can take back
      if (next !== undefined && next.type === "word" && next.value === "undo" && tokens[i + 1] !== undefined && tokens[i + 1].type === "word" && tokens[i + 1].value === "list") {
        i += 2;
        return node("undoList", next, {});
      }
      if (next !== undefined && next.type === "word" && COMMANDS[next.value] !== undefined) {
        i++;
        return node("variable", next, { name: next.value });
      }
    }

    // lines <from> to <to> of <file or text>, by line number
    // "lines" alone is a plain word, so this is a range only if "to" follows the first value
    if (isWord("lines")) {
      const linesToken = current();
      const savedIndex = i;
      const savedErrorCount = errors.length;
      i++;
      const from = parseBefore(["to"], parseMath);
      if (from !== null && isWord("to")) {
        i++;
        const to = parseBefore(["of"], parseMath);
        if (to === null) {
          return null;
        }
        if (!isWord("of")) {
          error("Expected 'of'");
          return null;
        }
        i++;
        const target = parseAccess();
        if (target === null) {
          return null;
        }
        return node("lines", linesToken, { from, to, target });
      }
      // not a range: go back, and forget errors from the try
      i = savedIndex;
      errors.length = savedErrorCount;
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
      // inside ( ), claimed words are free again; after the ), the claims are back
      const saved = follows;
      follows = [];
      const inner = parseExpression();
      follows = saved;
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
      // <name> of <value> is the same as <value>'s <name>, as in hyperscript
      if (isWord("of") && !token.value.startsWith("$")) {
        i++;
        const object = parseAccess();
        if (object === null) {
          return null;
        }
        return node("property", token, { object, name: token.value });
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
    blockDepth++;
    const body = parseCommands();
    let elseBody = [];
    if (isWord("else")) {
      i++;
      if (isWord("if")) {
        // else if: the nested if takes the one "end" for the whole chain
        const ifToken = current();
        i++;
        elseBody = [parseIf(ifToken)];
        blockDepth--;
        return { type: "if", condition, body, elseBody, line: token.line, column: token.column };
      }
      elseBody = parseCommands();
    }
    if (isWord("end")) {
      i++;
    } else {
      error("Expected 'end' for the 'if' at line " + token.line);
    }
    blockDepth--;
    return { type: "if", condition, body, elseBody, line: token.line, column: token.column };
  }

  // commands up to the "end" of a block, and the "end" itself
  function parseBody(token) {
    blockDepth++;
    const body = parseCommands();
    blockDepth--;
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
  // in "on error" (and not in a loop there), continue goes on after the failed command
  function parseLoopControl(token) {
    if (token.value === "continue" && inHandler && loopDepth === 0) {
      return { type: "continue", line: token.line, column: token.column };
    }
    if (loopDepth === 0) {
      errors.push({ message: "'" + token.value + "' is only allowed in a loop", line: token.line, column: token.column });
      return null;
    }
    return { type: token.value, line: token.line, column: token.column };
  }

  // help [<word> ...]: the words must be on the same line as help
  function parseHelp(token) {
    const words = [];
    while (current() !== undefined && current().type === "word" && current().line === token.line && (current().value !== "then" || words.length === 0)) {
      words.push(current().value);
      i++;
    }
    let word = null;
    if (words.length > 0) {
      word = words.join(" ");
    }
    return { type: "help", word, line: token.line, column: token.column };
  }

  // ask <question> [with <choice> or <choice> ...] [within <duration>]
  // only the human answers; see src/md/features/ask.md
  function parseAsk(token) {
    const question = parseBefore(["with", "within"], parseExpression);
    if (question === null) {
      return null;
    }
    const choices = [];
    if (isWord("with")) {
      i++;
      while (true) {
        const choice = parseBefore(["or", "within"], parseExpression);
        if (choice === null) {
          return null;
        }
        choices.push(choice);
        if (!isWord("or")) {
          break;
        }
        i++;
      }
      if (choices.length < 2) {
        error("Expected 'or' and a second choice");
        return null;
      }
    }
    let within = null;
    if (isWord("within")) {
      i++;
      within = parseDuration();
      if (within === null) {
        return null;
      }
    }
    return { type: "ask", question, choices, within, line: token.line, column: token.column };
  }

  // undo, undo <count>, undo changes to <file>
  function parseUndo(token) {
    if (isWord("changes")) {
      i++;
      if (!isWord("to")) {
        error("Expected 'to'");
        return null;
      }
      i++;
      const file = parseExpression();
      if (file === null) {
        return null;
      }
      return { type: "undo", count: null, file, line: token.line, column: token.column };
    }
    let count = null;
    if (hasValueOnLine(token)) {
      count = parseExpression();
      if (count === null) {
        return null;
      }
    }
    return { type: "undo", count, file: null, line: token.line, column: token.column };
  }
  // git <operation> ...: a hardened git, see src/md/features/git.md
  //   git status    git diff [<path>]    git log [<count>]    git show <commit>
  //   git branches  git branch
  //   git switch to [new branch] <branch>    git commit <files> with <message>    git merge <branch>    git delete branch <branch>
  function parseGit(token) {
    const op = current();
    if (op === undefined || op.type !== "word" || !GIT_OPERATIONS.includes(op.value)) {
      error("Expected a git operation: " + GIT_OPERATIONS.join(", "));
      return null;
    }
    i++;
    const command = { type: "git", operation: op.value, value: null, line: token.line, column: token.column };
    // git delete branch <branch>
    if (op.value === "delete") {
      if (!isWord("branch")) {
        error("Expected 'branch'");
        return null;
      }
      i++;
    }
    // git show <commit>, git merge <branch>, git delete branch <branch>
    if (op.value === "show" || op.value === "merge" || op.value === "delete") {
      command.value = parseExpression();
      if (command.value === null) {
        return null;
      }
    }
    // git switch to <branch>, git switch to new branch <branch>
    if (op.value === "switch") {
      if (!isWord("to")) {
        error("Expected 'to'");
        return null;
      }
      i++;
      command.create = false;
      if (isWord("new")) {
        i++;
        if (!isWord("branch")) {
          error("Expected 'branch'");
          return null;
        }
        i++;
        command.create = true;
      }
      command.value = parseExpression();
      if (command.value === null) {
        return null;
      }
    }
    // git commit <files> with <message>
    if (op.value === "commit") {
      command.value = parseBefore(["with"], parseExpression);
      if (command.value === null) {
        return null;
      }
      if (!isWord("with")) {
        error("Expected 'with' and a message");
        return null;
      }
      i++;
      command.message = parseExpression();
      if (command.message === null) {
        return null;
      }
    }
    // diff and log take an optional value, on the same line
    if ((op.value === "diff" || op.value === "log") && hasValueOnLine(token)) {
      command.value = parseExpression();
      if (command.value === null) {
        return null;
      }
    }
    return command;
  }

  // true if a value follows on the same line, and not a new command
  function hasValueOnLine(token) {
    const next = current();
    return next !== undefined && next.line === token.line && !isCommandStart();
  }
  // reject <message>, only in a "before" hook: the step does not happen
  function parseReject(token) {
    if (inHook !== "before") {
      errors.push({ message: "'reject' is only allowed in a 'before' hook", line: token.line, column: token.column });
      return null;
    }
    const message = parseExpression();
    if (message === null) {
      return null;
    }
    return { type: "reject", message, line: token.line, column: token.column };
  }

  // stop, only in "on error" (and not in a loop there): end with the error
  function parseStop(token) {
    if (!inHandler || loopDepth !== 0) {
      errors.push({ message: "'stop' is only allowed in 'on error'", line: token.line, column: token.column });
      return null;
    }
    return { type: "stop", line: token.line, column: token.column };
  }

  // on error ... end: handles errors in the whole script or tool
  function parseOn(token) {
    if (!isWord("error")) {
      error("Expected 'error'");
      return null;
    }
    i++;
    let problem = null;
    if (blockDepth !== (inTool || inHook !== null ? 1 : 0)) {
      problem = "'on error' must be at the top level of a script or tool";
    } else if (handlerSeen) {
      problem = "Only one 'on error' is allowed in a script or tool";
    }
    handlerSeen = true;
    inHandler = true;
    const body = parseBody(token);
    inHandler = false;
    if (problem !== null) {
      errors.push({ message: problem, line: token.line, column: token.column });
      return null;
    }
    return { type: "onError", body, line: token.line, column: token.column };
  }

  // read <expression>: puts the text of a file in the result
  function parseRead(token) {
    const file = parseAccess();
    return { type: "read", file, line: token.line, column: token.column };
  }

  // write <expression> to <file>
  // append <expression> to <file>
  function parseWrite(token) {
    const value = parseBefore(["to"], parseExpression);
    if (value === null) {
      return null;
    }
    if (!isWord("to")) {
      error("Expected 'to'");
      return null;
    }
    i++;
    const file = parseExpression();
    return { type: token.value, value, file, line: token.line, column: token.column };
  }

  // replace <expression> with <expression> in <file, variable or property>
  function parseReplace(token) {
    const old = parseBefore(["with"], parseExpression);
    if (old === null) {
      return null;
    }
    if (!isWord("with")) {
      error("Expected 'with'");
      return null;
    }
    i++;
    const replacement = parseBefore(["in"], parseExpression);
    if (replacement === null) {
      return null;
    }
    // replace lines 5 to 7 of <file> with <text>: an edit by line number
    if (old.type === "lines" && !isWord("in")) {
      return { type: "replaceLines", range: old, text: replacement, line: token.line, column: token.column };
    }
    if (!isWord("in")) {
      error("Expected 'in'");
      return null;
    }
    i++;
    const target = parseExpression();
    return { type: "replace", old, replacement, target, line: token.line, column: token.column };
  }

  // find <text> in <file, list of files, or text>
  function parseFind(token) {
    const text = parseBefore(["in"], parseExpression);
    if (text === null) {
      return null;
    }
    if (!isWord("in")) {
      error("Expected 'in'");
      return null;
    }
    i++;
    const target = parseExpression();
    if (target === null) {
      return null;
    }
    return { type: "find", text, target, line: token.line, column: token.column };
  }

  // put <text> before|after line <n> of <file>
  function parsePut(token) {
    const text = parseBefore(["before", "after"], parseExpression);
    if (text === null) {
      return null;
    }
    if (!isWord("before") && !isWord("after")) {
      error("Expected 'before' or 'after'");
      return null;
    }
    const where = current().value;
    i++;
    if (!isWord("line")) {
      error("Expected 'line'");
      return null;
    }
    i++;
    const number = parseBefore(["of"], parseMath);
    if (number === null) {
      return null;
    }
    if (!isWord("of")) {
      error("Expected 'of'");
      return null;
    }
    i++;
    const file = parseAccess();
    if (file === null) {
      return null;
    }
    return { type: "put", text, where, number, file, line: token.line, column: token.column };
  }

  // remove lines <from> to <to> of <file>
  function parseRemove(token) {
    const range = parseExpression();
    if (range === null) {
      return null;
    }
    if (range.type !== "lines") {
      errors.push({ message: "Expected lines <from> to <to> of <file>", line: range.line, column: range.column });
      return null;
    }
    return { type: "removeLines", range, line: token.line, column: token.column };
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
    if (target.type !== "variable" && target.type !== "property" && target.type !== "index" && target.type !== "result") {
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
    write: parseWrite,
    append: parseWrite,
    replace: parseReplace,
    find: parseFind,
    git: parseGit,
    undo: parseUndo,
    ask: parseAsk,
    put: parsePut,
    remove: parseRemove,
    run: parseRun,
    set: parseSet,
    increment: parseIncrement,
    decrement: parseIncrement,
    for: parseFor,
    repeat: parseRepeat,
    break: parseLoopControl,
    continue: parseLoopControl,
    stop: parseStop,
    help: parseHelp,
    reject: parseReject,
    on: parseOn,
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
      const errorCount = errors.length;
      const call = parseToolCall(token);
      if (errors.length > errorCount) {
        skipToNextCommand();
      }
      return call;
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
    while (!atEnd() && !isWord("end") && !isWord("else")) {
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

  // ----- tools -----

  // can the current token start a value? used to find positional tool arguments
  function canStartValue() {
    const token = current();
    if (token === undefined || isCommandStart() || isWord("with") || isWord("within")) {
      return false;
    }
    // a tool name starts the next call, not an argument
    if (token.type === "word" && tools.includes(token.value)) {
      return false;
    }
    if (token.type === "op") {
      return token.value === "(" || token.value === "[" || token.value === "{" || token.value === "-";
    }
    return true;
  }

  // name 'a', 'b'   or   name with x: 'a', y: 'b'   or   name
  function parseToolCall(token) {
    const args = [];
    const named = [];
    if (isWord("with")) {
      i++;
      while (true) {
        const name = current();
        if (name === undefined || name.type !== "word") {
          error("Expected an argument name");
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
        named.push({ name: name.value, value });
        if (!isOp(",")) {
          break;
        }
        i++;
      }
    } else if (canStartValue()) {
      while (true) {
        const value = parseExpression();
        if (value === null) {
          return null;
        }
        args.push(value);
        if (!isOp(",")) {
          break;
        }
        i++;
      }
    }
    let within = null;
    if (isWord("within")) {
      i++;
      within = parseDuration();
      if (within === null) {
        return null;
      }
    }
    return { type: "toolCall", name: token.value, args, named, within, line: token.line, column: token.column };
  }

  // tool <name> [with <param>, <param>] ... end
  function parseToolDefinition(token) {
    const name = parseName();
    if (name === null) {
      return null;
    }
    const params = [];
    if (isWord("with")) {
      i++;
      while (true) {
        const param = parseName();
        if (param === null) {
          return null;
        }
        params.push(param);
        if (!isOp(",")) {
          break;
        }
        i++;
      }
    }
    inTool = true;
    const savedHandlerSeen = handlerSeen;
    handlerSeen = false;
    const body = parseBody(token);
    handlerSeen = savedHandlerSeen;
    inTool = false;
    return { type: "tool", name, params, body, line: token.line, column: token.column };
  }

  // a duration: <expression> ms|s|second(s)|minute(s)|hour(s)
  const DURATION_UNITS = {
    ms: 1,
    s: 1000,
    second: 1000,
    seconds: 1000,
    minute: 60_000,
    minutes: 60_000,
    hour: 3_600_000,
    hours: 3_600_000,
  };

  function parseDuration() {
    const start = current() || { line: 0, column: 0 };
    const value = parseUnary();
    if (value === null) {
      return null;
    }
    const unit = current();
    if (unit === undefined || unit.type !== "word" || DURATION_UNITS[unit.value] === undefined) {
      error("Expected a time unit: ms, s, seconds, minutes or hours");
      return null;
    }
    i++;
    return { type: "duration", value, ms: DURATION_UNITS[unit.value], line: start.line, column: start.column };
  }

  // run <program> [with <arg>, <arg>] [within <duration>], only inside a tool
  function parseRun(token) {
    if (!inTool) {
      errors.push({ message: "'run' is only allowed in a tool", line: token.line, column: token.column });
      return null;
    }
    const program = parseExpression();
    if (program === null) {
      return null;
    }
    let args = null;
    if (isWord("with")) {
      i++;
      args = [];
      while (true) {
        const arg = parseExpression();
        if (arg === null) {
          return null;
        }
        args.push(arg);
        if (!isOp(",")) {
          break;
        }
        i++;
      }
    }
    let within = null;
    if (isWord("within")) {
      i++;
      within = parseDuration();
      if (within === null) {
        return null;
      }
    }
    return { type: "run", program, args, within, line: token.line, column: token.column };
  }

  // at the top of AGENTS.talk:
  //   allow env NAME, NAME
  //   allow changes to @/.github/, @/.gitignore
  //   allow git push
  function parseAllow(token) {
    if (isWord("changes")) {
      return parseAllowChanges(token);
    }
    if (isWord("git")) {
      i++;
      if (!isWord("push")) {
        error("Expected 'push'");
        return null;
      }
      i++;
      return { type: "allowGitPush", line: token.line, column: token.column };
    }
    if (!isWord("env")) {
      error("Expected 'env', 'changes to' or 'git push'");
      return null;
    }
    i++;
    const names = [];
    while (true) {
      const name = parseName();
      if (name === null) {
        return null;
      }
      names.push(name);
      if (!isOp(",")) {
        break;
      }
      i++;
    }
    return { type: "allowEnv", names, line: token.line, column: token.column };
  }

  // allow changes to <path>, <path>: hidden paths that scripts can change
  function parseAllowChanges(token) {
    i++;
    if (!isWord("to")) {
      error("Expected 'to'");
      return null;
    }
    i++;
    const paths = [];
    while (true) {
      const path = current();
      if (path === undefined || path.type !== "path") {
        error("Expected a path, such as @/.github/");
        return null;
      }
      i++;
      paths.push(path.value);
      if (!isOp(",")) {
        break;
      }
      i++;
    }
    return { type: "allowChanges", paths, line: token.line, column: token.column };
  }

  // before <step> ... end and after <step> ... end, in AGENTS.talk
  // the step is a command name (write, run, ...), "change", or a tool name
  function parseHook(token) {
    const name = current();
    if (name === undefined || name.type !== "word") {
      error("Expected a step name, such as write, run or change");
      return null;
    }
    i++;
    inHook = token.value;
    const savedHandlerSeen = handlerSeen;
    handlerSeen = false;
    const body = parseBody(token);
    handlerSeen = savedHandlerSeen;
    inHook = null;
    return { type: "hook", when: token.value, name: name.value, body, line: token.line, column: token.column };
  }

  // AGENTS.talk: only definitions at the top level
  function parseDefinitions() {
    const definitions = [];
    while (!atEnd()) {
      if (isWord("allow")) {
        const token = current();
        i++;
        const definition = parseAllow(token);
        if (definition !== null) {
          definitions.push(definition);
        } else {
          while (!atEnd() && !isWord("tool") && !isWord("allow") && !isWord("import") && !isWord("before") && !isWord("after")) {
            i++;
          }
        }
        continue;
      }
      if (isWord("import")) {
        const token = current();
        i++;
        const path = current();
        if (path === undefined || path.type !== "path") {
          error("Expected a path after 'import', such as ./talk/git.talk");
          while (!atEnd() && !isWord("tool") && !isWord("allow") && !isWord("import") && !isWord("before") && !isWord("after")) {
            i++;
          }
          continue;
        }
        i++;
        definitions.push({ type: "import", path: path.value, line: token.line, column: token.column });
        continue;
      }
      if (isWord("before") || isWord("after")) {
        const token = current();
        i++;
        const definition = parseHook(token);
        if (definition !== null) {
          definitions.push(definition);
        } else {
          skipToNextCommand();
        }
        continue;
      }
      if (isWord("tool")) {
        const token = current();
        i++;
        const definition = parseToolDefinition(token);
        if (definition !== null) {
          definitions.push(definition);
        } else {
          skipToNextCommand();
        }
        continue;
      }
      error("Only definitions are allowed here, such as 'tool'");
      i++;
      while (!atEnd() && !isWord("tool") && !isWord("allow") && !isWord("import") && !isWord("before") && !isWord("after")) {
        i++;
      }
    }
    return definitions;
  }

  // ----- script -----

  if (options.definitions) {
    return { script: { type: "definitions", definitions: parseDefinitions() }, errors };
  }

  const commands = parseCommands();
  while (!atEnd()) {
    // only a stray 'end' or 'else' can stop parseCommands before the end of the source
    error("Unexpected '" + current().value + "'");
    i++;
    commands.push(...parseCommands());
  }

  return { script: { type: "script", commands }, errors };
}
