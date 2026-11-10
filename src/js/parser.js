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
// how deep expressions and blocks can nest
const MAX_NESTING = 100;

// words that end or split a block, so they can never be names
const BLOCK_WORDS = ["end", "then", "else"];

// an expression can have this many operators in a row, such as a + b + c
const MAX_CHAIN = 500;

// words that join values, so they never start one: "set sorted to 5" sets a variable named sorted
const LINK_WORDS = ["to", "is", "and", "or", "of", "in", "with", "within", "as", "then", "matches", "contains", "starts", "ends", "does", "index", "by", "onto", "else", "end"];

export const GIT_OPERATIONS = ["status", "diff", "log", "show", "branches", "branch", "switch", "commit", "merge", "rebase", "move", "push", "delete"];

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
 * @param {boolean} [options.policy]        true for a policy file: definitions, plus policy lines
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

  // the target of an "in <target> do ... end" block, for replace and find with no "in" of their own
  let inTarget = null;

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
    return Object.hasOwn(COMMANDS, token.value) || token.value === "end" || token.value === "else" || token.value === "then";
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
    return nested(parseLogic);
  }

  // how deep expressions and blocks are; a cap keeps a deep script from overflowing the stack
  let depth = 0;
  function nested(parseInner) {
    depth++;
    if (depth > MAX_NESTING) {
      throw { tooDeep: true, token: current() || tokens[tokens.length - 1] };
    }
    try {
      return parseInner();
    } finally {
      depth--;
    }
  }

  // a chain such as a + b + c is as deep as it is long when it runs, so it has a cap too
  function chainStep(count) {
    if (count > MAX_CHAIN) {
      throw { tooLong: true, token: current() };
    }
  }

  function parseLogic() {
    let left = parseComparison();
    let operator = null;
    let count = 0;
    while (left !== null && (isWord("and") || isWord("or"))) {
      chainStep(++count);
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
    // is private, is untrusted: taint checks; see src/md/features/taint.md
    if (isWord("private") || isWord("untrusted")) {
      const word = current().value;
      i++;
      return operator + " " + word;
    }
    if (isWord("in")) {
      i++;
      return operator + " in";
    }
    return operator;
  }

  // operators with no right side
  const CHECKS = ["exists", "does not exist", "is empty", "is not empty", "is private", "is not private", "is untrusted", "is not untrusted"];

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
    } else if (isWord("matches")) {
      i++;
      operator = "matches";
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
    if (CHECKS.includes(operator)) {
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
    let count = 0;
    while (left !== null && isMathOperator()) {
      chainStep(++count);
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
    let count = 0;
    while (value !== null && isWord("as")) {
      chainStep(++count);
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
      const value = nested(parseUnary);
      if (value === null) {
        return null;
      }
      return node("unary", token, { operator: token.value, value });
    }
    return parseAccess();
  }

  function parseAccess() {
    let value = parsePrimary();
    let count = 0;
    while (value !== null) {
      chainStep(++count);
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
      // the audit: the steps of this session
      if (next !== undefined && next.type === "word" && next.value === "audit") {
        i++;
        return node("audit", next, {});
      }
      // the processes: the background processes, newest first
      if (next !== undefined && next.type === "word" && next.value === "processes") {
        i++;
        return node("processes", next, {});
      }
      // the previous output: the full print output of the last script, which the host can cut
      if (next !== undefined && next.type === "word" && next.value === "previous" && tokens[i + 1] !== undefined && tokens[i + 1].type === "word" && tokens[i + 1].value === "output") {
        i += 2;
        return node("previousOutput", next, {});
      }
      // the undo list: the scripts that undo can take back
      if (next !== undefined && next.type === "word" && next.value === "undo" && tokens[i + 1] !== undefined && tokens[i + 1].type === "word" && tokens[i + 1].value === "list") {
        i += 2;
        return node("undoList", next, {});
      }
      // a command word or a tool name: in a hook for that step, the deploy's args
      if (next !== undefined && next.type === "word" && (Object.hasOwn(COMMANDS, next.value) || tools.includes(next.value))) {
        i++;
        return node("variable", next, { name: next.value });
      }
    }

    // fetch as a value, as read is: (fetch url as response)'s status
    if (isWord("fetch")) {
      const fetchToken = current();
      i++;
      return parseFetch(fetchToken);
    }
    // process <name>: a background process, by name
    if (isWord("process")) {
      const after = tokens[i + 1];
      if (after !== undefined && after.line === current().line && (after.type === "string" || after.type === "template" || after.type === "word")) {
        const processToken = current();
        i++;
        const name = parseAccess();
        if (name === null) {
          return null;
        }
        return node("process", processToken, { name });
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
        // in an "in <target> do ... end" block, a range with no "of" uses the block's target
        if (!isWord("of") && inTarget !== null) {
          return node("lines", linesToken, { from, to, target: inTarget });
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
    // line <n> of <file or text>: one line, by number
    // "line" alone is a plain word, such as a loop variable, so this is a line only if "of" follows the number
    if (isWord("line")) {
      const lineToken = current();
      const savedIndex = i;
      const savedErrorCount = errors.length;
      i++;
      const number = parseBefore(["of"], parseMath);
      if (number !== null && isWord("of")) {
        i++;
        const target = parseAccess();
        if (target === null) {
          return null;
        }
        return node("line", lineToken, { number, target });
      }
      // in an "in <target> do ... end" block, "line <n>" with no "of" uses the block's target;
      // the number must be on the same line, so a loop variable named line still works
      if (number !== null && inTarget !== null && number.line === lineToken.line) {
        return node("line", lineToken, { number, target: inTarget });
      }
      // not a line: go back, and forget errors from the try
      i = savedIndex;
      errors.length = savedErrorCount;
    }

    // find as a value: set hits to find 'TODO' in @/src/**/*.js
    // the target takes only a value with access, so "find 'x' in f is empty" checks the found lines
    if (isWord("find")) {
      const findToken = current();
      i++;
      return parseFind(findToken, parseAccess);
    }

    // sorted <list>, unique <list>: a new list; only with a value after it on the same line,
    // so "sorted" alone stays a plain word, as in "set sorted to 5"
    if (isWord("sorted") || isWord("unique")) {
      const wordToken = current();
      const after = tokens[i + 1];
      const joins = after !== undefined && after.type === "word" && LINK_WORDS.includes(after.value);
      if (after !== undefined && after.line === wordToken.line && !joins) {
        const savedIndex = i;
        const savedErrorCount = errors.length;
        i++;
        const list = parseAccess();
        if (list !== null) {
          return node("listOp", wordToken, { operation: wordToken.value, list });
        }
        // not a list: go back, and forget errors from the try
        i = savedIndex;
        errors.length = savedErrorCount;
      }
    }

    // pattern '<regexp>': only with text after it on the same line, so "pattern" alone stays a plain word
    if (isWord("pattern")) {
      const after = tokens[i + 1];
      if (after !== undefined && after.line === current().line && (after.type === "string" || after.type === "template")) {
        const patternToken = current();
        i++;
        const source = parseAccess();
        if (source === null) {
          return null;
        }
        return node("pattern", patternToken, { source });
      }
    }

    // secret NAME: a value that the script can send to an allowed host, but never see
    // only with a name after it on the same line, so "secret" alone stays a plain word, as in "set secret to 1"
    if (isWord("secret")) {
      const after = tokens[i + 1];
      if (after !== undefined && after.line === current().line && after.type === "word" && !LINK_WORDS.includes(after.value)) {
        const secretToken = current();
        i += 2;
        return node("secret", secretToken, { name: after.value });
      }
    }

    // first <n> of <x>, last <n> of <x>: up to n items, or lines of text or a file
    // only with a value and "of" after it, so "first of x" and a variable named first still work
    if (isWord("first") || isWord("last")) {
      const wordToken = current();
      const after = tokens[i + 1];
      if (after !== undefined && !(after.type === "word" && (after.value === "of" || LINK_WORDS.includes(after.value)))) {
        const savedIndex = i;
        const savedErrorCount = errors.length;
        i++;
        const count = parseBefore(["of"], parseMath);
        if (count !== null && isWord("of")) {
          i++;
          const target = parseAccess();
          if (target === null) {
            return null;
          }
          return node("take", wordToken, { which: wordToken.value, count, target });
        }
        // not a count: go back, and forget errors from the try
        i = savedIndex;
        errors.length = savedErrorCount;
      }
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
    // a tool call as a value: set tests to run_tests
    if (token !== undefined && token.type === "word" && tools.includes(token.value)) {
      i++;
      return parseToolCall(token);
    }
    // a command word on the same line is likely a name; on a new line it starts the next command
    const before = tokens[i - 1];
    if (token !== undefined && token.type === "word" && Object.hasOwn(COMMANDS, token.value) && before !== undefined && before.line === token.line) {
      error("Expected a value, found the command word '" + token.value + "'. If it is a name, write 'the " + token.value + "'");
      return null;
    }
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
      if (!Number.isFinite(Number(token.value))) {
        error("The number " + token.value.slice(0, 20) + "... is too large");
        return null;
      }
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
        const object = nested(parseAccess);
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
    // git move <file> to <file>
    if (op.value === "move") {
      command.value = parseBefore(["to"], parseExpression);
      if (command.value === null) {
        return null;
      }
      if (!isWord("to")) {
        error("Expected 'to'");
        return null;
      }
      i++;
      command.to = parseExpression();
      if (command.to === null) {
        return null;
      }
    }
    // git rebase onto <branch>
    if (op.value === "rebase") {
      if (!isWord("onto")) {
        error("Expected 'onto'");
        return null;
      }
      i++;
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

  // stop, only in "on error" (and not in a loop there): end with the error; or stop process <name>
  function parseStop(token) {
    // stop process <name>: anywhere
    if (isWord("process")) {
      i++;
      const name = parseExpression();
      if (name === null) {
        return null;
      }
      return { type: "stopProcess", name, line: token.line, column: token.column };
    }
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
    // in an "in <target> do ... end" block, a read with nothing after it on its line reads the block's target
    const next = current();
    if (inTarget !== null && (next === undefined || next.line !== token.line || isWord("then"))) {
      return { type: "read", file: inTarget, line: token.line, column: token.column };
    }
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
    // replace lines 5 to 7 of <file> with <text>: an edit by line number; "of" names the file,
    // so it never takes an "in", and an "in" after it starts a new command
    if (old.type === "lines") {
      return { type: "replaceLines", range: old, text: replacement, line: token.line, column: token.column };
    }
    // in an "in <target> do ... end" block, the block names the target, and an "in" here starts a new command
    if (inTarget !== null && old.type !== "lines") {
      return { type: "replace", old, replacement, target: inTarget, line: token.line, column: token.column };
    }
    if (!isWord("in")) {
      error("Expected 'in'");
      return null;
    }
    i++;
    const target = parseExpression();
    return { type: "replace", old, replacement, target, line: token.line, column: token.column };
  }

  // in <target> replace <old> with <new>, in <target> find <text>:
  // the target first, for one command; the same as "replace ... in <target>" and "find ... in <target>"
  function parseIn(token) {
    const target = parseBefore(["replace", "find", "do"], parseExpression);
    if (target === null) {
      return null;
    }
    // in <target> do ... end: replace and find with no "in" of their own use the target
    if (isWord("do")) {
      i++;
      const savedTarget = inTarget;
      inTarget = target;
      const body = parseBody(token);
      inTarget = savedTarget;
      return { type: "do", body, line: token.line, column: token.column };
    }
    if (isWord("replace")) {
      const replaceToken = current();
      i++;
      const old = parseBefore(["with"], parseExpression);
      if (old === null) {
        return null;
      }
      if (old.type === "lines") {
        error("Use 'replace lines ... of <file> with <text>' for a line edit");
        return null;
      }
      if (!isWord("with")) {
        error("Expected 'with'");
        return null;
      }
      i++;
      // an "in" after this starts a new command, as in a block
      const replacement = parseBefore(["in"], parseExpression);
      if (replacement === null) {
        return null;
      }
      return { type: "replace", old, replacement, target, line: replaceToken.line, column: replaceToken.column };
    }
    if (isWord("find")) {
      const findToken = current();
      i++;
      const text = parseBefore(["in"], parseExpression);
      if (text === null) {
        return null;
      }
      return { type: "find", text, target, line: findToken.line, column: findToken.column };
    }
    error("Expected replace, find or do after 'in " + "<file>'");
    return null;
  }

  // find <text> in <file, list of files, or text>
  function parseFind(token, parseTarget = parseExpression) {
    const text = parseBefore(["in"], parseExpression);
    if (text === null) {
      return null;
    }
    // in an "in <target> do ... end" block, the block names the target
    if (inTarget !== null) {
      return { type: "find", text, target: inTarget, line: token.line, column: token.column };
    }
    if (!isWord("in")) {
      error("Expected 'in'");
      return null;
    }
    i++;
    const target = parseTarget();
    if (target === null) {
      return null;
    }
    return { type: "find", text, target, line: token.line, column: token.column };
  }

  // delete <file>
  function parseDelete(token) {
    const file = parseExpression();
    if (file === null) {
      return null;
    }
    return { type: "delete", file, line: token.line, column: token.column };
  }

  // move <file> to <file>
  function parseMove(token) {
    const from = parseBefore(["to"], parseExpression);
    if (from === null) {
      return null;
    }
    if (!isWord("to")) {
      error("Expected 'to'");
      return null;
    }
    i++;
    const to = parseExpression();
    if (to === null) {
      return null;
    }
    return { type: "move", from, to, line: token.line, column: token.column };
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
    // in an "in <target> do ... end" block, a put with no "of" uses the block's target
    if (!isWord("of") && inTarget !== null) {
      return { type: "put", text, where, number, file: inTarget, line: token.line, column: token.column };
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
    // a command word cannot be a name: set stop to 5 fails, set the stop to 5 works
    if (start.type === "word" && Object.hasOwn(COMMANDS, start.value)) {
      i++;
      errors.push({ message: "'" + start.value + "' is a command word, so it cannot be a name. Use another name, such as 'my_" + start.value + "', or write 'the " + start.value + "'", line: start.line, column: start.column });
      return null;
    }
    // a block word cannot be a name either, even after "the": set end to 1 fails
    const word = start.type === "word" && start.value === "the" ? tokens[i + 1] : start;
    if (word !== undefined && word.type === "word" && BLOCK_WORDS.includes(word.value)) {
      i += word === start ? 1 : 2;
      errors.push({ message: "'" + word.value + "' is a block word, so it cannot be a name. Use another name, such as 'last'", line: word.line, column: word.column });
      return null;
    }
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
    move: parseMove,
    delete: parseDelete,
    in: parseIn,
    git: parseGit,
    undo: parseUndo,
    ask: parseAsk,
    fetch: parseFetch,
    start: parseStart,
    wait: parseWait,
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

    // own names only: a script word such as __proto__ is not a command
    const parser = Object.hasOwn(COMMANDS, token.value) ? COMMANDS[token.value] : undefined;
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
    return nested(parseCommandList);
  }

  function parseCommandList() {
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
  // name: value, name: value; adds to the list, and gives false on an error
  function parseNamedArgs(named) {
    while (true) {
      const name = current();
      if (name === undefined || name.type !== "word") {
        error("Expected an argument name");
        return false;
      }
      if (named.some((arg) => arg.name === name.value)) {
        error("The argument '" + name.value + "' is given twice");
        return false;
      }
      i++;
      if (!expectOp(":")) {
        return false;
      }
      const value = parseExpression();
      if (value === null) {
        return false;
      }
      named.push({ name: name.value, value });
      if (!isOp(",")) {
        return true;
      }
      i++;
    }
  }

  // wait <duration>, wait until <condition> [within <duration>], as in hyperscript
  function parseWait(token) {
    if (isWord("until")) {
      i++;
      const condition = parseBefore(["within"], parseExpression);
      if (condition === null) {
        return null;
      }
      let within = null;
      if (isWord("within")) {
        i++;
        within = parseDuration();
        if (within === null) {
          return null;
        }
      }
      return { type: "waitUntil", condition, within, line: token.line, column: token.column };
    }
    const duration = parseDuration();
    if (duration === null) {
      return null;
    }
    return { type: "wait", duration, line: token.line, column: token.column };
  }

  // fetch <url> [as json | as response | as text] [with name: value, ...] [within <duration>]
  // see src/md/features/fetch.md
  function parseFetch(token) {
    const url = parseBefore(["as", "with", "within"], parseExpression);
    if (url === null) {
      return null;
    }
    let as = "text";
    if (isWord("as")) {
      i++;
      if (!isWord("json") && !isWord("response") && !isWord("text")) {
        error("Expected json, response or text");
        return null;
      }
      as = current().value;
      i++;
    }
    const named = [];
    if (isWord("with")) {
      i++;
      const ok = parseBefore(["within"], () => parseNamedArgs(named));
      if (!ok) {
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
    return { type: "fetch", url, as, named, within, line: token.line, column: token.column };
  }

  function parseToolCall(token) {
    const args = [];
    const named = [];
    if (isWord("with")) {
      i++;
      if (!parseNamedArgs(named)) {
        return null;
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

  // using secret NAME, NAME | using secrets NAME, NAME: after run or start, before "in a sandbox"
  // gives the list of names, an empty list with no "using", or null on an error
  function parseUsing() {
    if (!isWord("using")) {
      return [];
    }
    i++;
    if (!isWord("secret") && !isWord("secrets")) {
      error("Expected 'secret' or 'secrets', as in: using secret NPM_TOKEN");
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
    return names;
  }

  // run <program> [with <arg>, <arg>] [using secret NAME] [in a sandbox ...] [within <duration>], only inside a tool
  function parseRun(token) {
    if (!inTool) {
      errors.push({ message: "'run' is only allowed in a tool", line: token.line, column: token.column });
      return null;
    }
    const program = parseBefore(["with", "using", "in", "within"], parseExpression);
    if (program === null) {
      return null;
    }
    let args = null;
    if (isWord("with")) {
      i++;
      args = [];
      while (true) {
        const arg = parseBefore(["using", "in", "within"], parseExpression);
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
    const secrets = parseUsing();
    if (secrets === null) {
      return null;
    }
    let sandbox = null;
    let subagent = null;
    // run '<prompt>' in a subagent with only <tool>, ...: see src/md/features/subagents.md
    if (isWord("in") && tokens[i + 2] !== undefined && tokens[i + 2].type === "word" && tokens[i + 2].value === "subagent") {
      subagent = parseSubagent();
      if (subagent === null) {
        return null;
      }
      if (args !== null || secrets.length > 0) {
        error("A subagent takes a prompt only, with no 'with' arguments or 'using secret'");
        return null;
      }
    } else if (isWord("in")) {
      sandbox = parseSandbox();
      if (sandbox === null) {
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
    return { type: "run", program, args, secrets, sandbox, subagent, within, line: token.line, column: token.column };
  }

  // in a subagent with only <tool>, <tool>: after run; gives { tools }
  function parseSubagent() {
    i++;
    if (!isWord("a")) {
      error("Expected 'a subagent'");
      return null;
    }
    i++;
    i++;
    if (!isWord("with")) {
      error("Expected 'with only', as in: in a subagent with only gh_issues");
      return null;
    }
    i++;
    if (!isWord("only")) {
      error("Expected 'only', as in: in a subagent with only gh_issues");
      return null;
    }
    i++;
    const tools = [];
    while (true) {
      const name = parseName();
      if (name === null) {
        return null;
      }
      tools.push(name);
      if (!isOp(",")) {
        break;
      }
      i++;
    }
    return { tools };
  }

  // use model '<id>' for subagents [with secret NAME]: at the top of AGENTS.talk
  function parseUseModel(token) {
    if (!isWord("model")) {
      error("Expected 'model', as in: use model 'claude-sonnet-5-5' for subagents with secret ANTHROPIC_API_KEY");
      return null;
    }
    i++;
    const model = current();
    if (model === undefined || model.type !== "string") {
      error("Expected a model name in quotes, such as 'claude-sonnet-5-5'");
      return null;
    }
    i++;
    for (const word of ["for", "subagents"]) {
      if (!isWord(word)) {
        error("Expected '" + word + "', as in: use model 'claude-sonnet-5-5' for subagents with secret ANTHROPIC_API_KEY");
        return null;
      }
      i++;
    }
    // with secret NAME: the key, for a harness that cannot lend its model; pi needs none
    let secret = null;
    if (isWord("with")) {
      i++;
      if (!isWord("secret")) {
        error("Expected 'secret', as in: use model 'claude-sonnet-5-5' for subagents with secret ANTHROPIC_API_KEY");
        return null;
      }
      i++;
      secret = parseName();
      if (secret === null) {
        return null;
      }
    }
    return { type: "useModel", model: model.value, secret, line: token.line, column: token.column };
  }

  // in a sandbox [with network, local network, writes to <path>, reads of <path>], after run or start
  // see src/md/features/sandbox-run.md
  function parseSandbox() {
    i++;
    if (!isWord("a")) {
      error("Expected 'a sandbox'");
      return null;
    }
    i++;
    if (!isWord("sandbox")) {
      error("Expected 'sandbox'");
      return null;
    }
    i++;
    const sandbox = { network: false, localNetwork: false, writes: [], reads: [] };
    if (!isWord("with")) {
      return sandbox;
    }
    i++;
    while (true) {
      if (isWord("network")) {
        i++;
        sandbox.network = true;
      } else if (isWord("local")) {
        // with local network: localhost only
        i++;
        if (!isWord("network")) {
          error("Expected 'network'");
          return null;
        }
        i++;
        sandbox.localNetwork = true;
      } else if (isWord("writes")) {
        i++;
        if (!isWord("to")) {
          error("Expected 'to'");
          return null;
        }
        i++;
        const path = parseBefore(["within"], parseExpression);
        if (path === null || !isLiteralGrant(path, "writes to")) {
          return null;
        }
        sandbox.writes.push(path);
      } else if (isWord("reads")) {
        i++;
        if (!isWord("of")) {
          error("Expected 'of'");
          return null;
        }
        i++;
        const path = parseBefore(["within"], parseExpression);
        if (path === null || !isLiteralGrant(path, "reads of")) {
          return null;
        }
        sandbox.reads.push(path);
      } else {
        error("Expected network, local network, writes to <path>, or reads of <path>");
        return null;
      }
      if (!isOp(",")) {
        return sandbox;
      }
      i++;
    }
  }
  // a sandbox grant must be written out in AGENTS.talk, as text or a path, so the human sees it
  // a variable or a tool argument could let the agent pick any folder on the machine
  function isLiteralGrant(path, words) {
    if (path.type === "string" || path.type === "path") {
      return true;
    }
    errors.push({ message: "'" + words + "' needs a path written out, such as " + words + " '~/.m2'. It cannot come from a variable or a tool argument", line: path.line, column: path.column });
    return false;
  }

  // start <program> [with <arg>, <arg>] as <name>, only inside a tool: a background process
  function parseStart(token) {
    if (!inTool) {
      errors.push({ message: "'start' is only allowed in a tool", line: token.line, column: token.column });
      return null;
    }
    const program = parseBefore(["with", "as", "using", "in"], parseExpression);
    if (program === null) {
      return null;
    }
    let args = null;
    if (isWord("with")) {
      i++;
      args = [];
      while (true) {
        const arg = parseBefore(["as", "using", "in"], parseExpression);
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
    if (!isWord("as")) {
      error("Expected 'as' and a name, such as: start 'npm run dev' as 'site'");
      return null;
    }
    i++;
    const name = parseBefore(["using", "in"], parseExpression);
    if (name === null) {
      return null;
    }
    const secrets = parseUsing();
    if (secrets === null) {
      return null;
    }
    // start '<prompt>' as '<name>' in a subagent with only <tool>, ...: a subagent in the background
    if (isWord("in") && tokens[i + 2] !== undefined && tokens[i + 2].type === "word" && tokens[i + 2].value === "subagent") {
      const subagent = parseSubagent();
      if (subagent === null) {
        return null;
      }
      if (args !== null || secrets.length > 0) {
        error("A subagent takes a prompt only, with no 'with' arguments or 'using secret'");
        return null;
      }
      return { type: "start", program, args, name, secrets, sandbox: null, subagent, line: token.line, column: token.column };
    }
    let sandbox = null;
    if (isWord("in")) {
      sandbox = parseSandbox();
      if (sandbox === null) {
        return null;
      }
    }
    return { type: "start", program, args, name, secrets, sandbox, subagent: null, line: token.line, column: token.column };
  }

  // at the top of AGENTS.talk:
  //   allow env NAME, NAME
  //   allow changes to @/.github/, @/.gitignore
  //   allow fetch from 'api.github.com', '*.npmjs.org'
  function parseAllow(token) {
    if (isWord("fetch")) {
      i++;
      if (!isWord("from")) {
        error("Expected 'from'");
        return null;
      }
      i++;
      const hosts = parseHosts();
      if (hosts === null) {
        return null;
      }
      return { type: "allowFetch", hosts, line: token.line, column: token.column };
    }
    if (isWord("changes")) {
      return parseAllowChanges(token);
    }
    if (isWord("secret")) {
      return parseAllowSecret(token);
    }
    if (!isWord("env")) {
      error("Expected 'env', 'changes to', 'fetch from' or 'secret'");
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

  // allow secret NAME for fetch to 'api.github.com', '*.github.com' | allow secret NAME for run
  // see src/md/features/secrets.md
  function parseAllowSecret(token) {
    i++;
    const name = parseName();
    if (name === null) {
      return null;
    }
    if (!isWord("for")) {
      error("Expected 'for', as in: allow secret " + name + " for fetch to 'api.github.com'");
      return null;
    }
    i++;
    // allow secret NAME for run: a run or start that is provided it, with "using secret NAME"
    if (isWord("run")) {
      i++;
      return { type: "allowSecret", name, hosts: [], run: true, subagents: false, line: token.line, column: token.column };
    }
    // allow secret NAME for subagents: the key for the model, in "use model ... with secret NAME"
    if (isWord("subagents")) {
      i++;
      return { type: "allowSecret", name, hosts: [], run: false, subagents: true, line: token.line, column: token.column };
    }
    if (!isWord("fetch")) {
      error("Expected 'fetch', 'run' or 'subagents', as in: allow secret " + name + " for fetch to 'api.github.com'");
      return null;
    }
    i++;
    if (!isWord("to")) {
      error("Expected 'to'");
      return null;
    }
    i++;
    const hosts = parseHosts();
    if (hosts === null) {
      return null;
    }
    return { type: "allowSecret", name, hosts, run: false, subagents: false, line: token.line, column: token.column };
  }

  // 'api.github.com', '*.npmjs.org': hosts in quotes, lower case
  function parseHosts() {
    const hosts = [];
    while (true) {
      const host = current();
      if (host === undefined || host.type !== "string") {
        error("Expected a host in quotes, such as 'api.github.com'");
        return null;
      }
      i++;
      hosts.push(host.value.toLowerCase());
      if (!isOp(",")) {
        break;
      }
      i++;
    }
    return hosts;
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

  // one line of a policy, after its first word:
  //   policy 'name'
  //   require sandbox for run, start
  //   limit fetch to 'host', ...    limit env to NAME, ...    limit changes to @/path, ...
  //   deny git push | deny start | deny fetch | deny run | deny writes
  //   audit also to '/path/'
  function parsePolicyLine(token) {
    const at = { line: token.line, column: token.column };
    if (token.value === "policy") {
      const name = current();
      if (name === undefined || name.type !== "string") {
        error("Expected a name in quotes, such as policy 'acme-secure'");
        return null;
      }
      i++;
      return { type: "policyName", name: name.value, ...at };
    }
    if (token.value === "require") {
      if (!isWord("sandbox")) {
        error("Expected 'sandbox for run, start'");
        return null;
      }
      i++;
      if (!isWord("for")) {
        error("Expected 'for'");
        return null;
      }
      i++;
      const commands = [];
      while (isWord("run") || isWord("start")) {
        commands.push(current().value);
        i++;
        if (!isOp(",")) {
          break;
        }
        i++;
      }
      if (commands.length === 0) {
        error("Expected run, start, or both");
        return null;
      }
      return { type: "requireSandbox", commands, ...at };
    }
    if (token.value === "limit") {
      const what = current();
      if (what === undefined || !["fetch", "env", "changes", "secrets"].includes(what.value)) {
        error("Expected fetch, env, changes or secrets");
        return null;
      }
      i++;
      if (!isWord("to")) {
        error("Expected 'to'");
        return null;
      }
      i++;
      // fetch: hosts in quotes; env and secrets: names; changes: paths
      const wanted = { fetch: "string", env: "word", changes: "path", secrets: "word" }[what.value];
      const values = [];
      while (true) {
        const value = current();
        if (value === undefined || value.type !== wanted) {
          error("Expected " + { string: "a host in quotes", word: "a name", path: "a path, such as @/.github/" }[wanted]);
          return null;
        }
        i++;
        values.push(what.value === "fetch" ? value.value.toLowerCase() : value.value);
        if (!isOp(",")) {
          break;
        }
        i++;
      }
      return { type: "limit", what: what.value, values, ...at };
    }
    if (token.value === "deny") {
      let what = null;
      if (isWord("git")) {
        i++;
        if (!isWord("push")) {
          error("Expected 'push'");
          return null;
        }
        what = "git push";
      } else if (isWord("start") || isWord("fetch") || isWord("run") || isWord("writes") || isWord("secrets") || isWord("subagents")) {
        what = current().value;
      } else {
        error("Expected git push, start, fetch, run, writes, secrets or subagents");
        return null;
      }
      i++;
      return { type: "deny", what, ...at };
    }
    // audit also to '<folder>'
    i++;
    if (!isWord("to")) {
      error("Expected 'to'");
      return null;
    }
    i++;
    const folder = current();
    if (folder === undefined || folder.type !== "string") {
      error("Expected a folder in quotes, such as '/var/log/clank-talk/'");
      return null;
    }
    i++;
    return { type: "auditAlso", folder: folder.value, ...at };
  }

  // keep audit for 7 days | keep audit for at least 30 days (a policy: the fewest days that AGENTS.talk can keep)
  function parseKeepAudit(token) {
    for (const word of ["audit", "for"]) {
      if (!isWord(word)) {
        error("Expected '" + word + "', as in: keep audit for 7 days");
        return null;
      }
      i++;
    }
    let atLeast = false;
    if (isWord("at")) {
      i++;
      if (!isWord("least")) {
        error("Expected 'least', as in: keep audit for at least 30 days");
        return null;
      }
      i++;
      atLeast = true;
    }
    if (atLeast !== Boolean(options.policy)) {
      error(options.policy ? "A policy sets the fewest days: keep audit for at least 30 days" : "'at least' is only for a policy. Use: keep audit for 7 days");
      return null;
    }
    // a number token holds its digits as text
    const number = current();
    const days = number === undefined || number.type !== "number" ? NaN : Number(number.value);
    if (!Number.isInteger(days) || days < 1) {
      error("Expected a whole number of days above 0, such as: keep audit for 7 days");
      return null;
    }
    i++;
    if (!isWord("days") && !isWord("day")) {
      error("Expected 'days', as in: keep audit for 7 days");
      return null;
    }
    i++;
    return { type: "keepAudit", days, atLeast, line: token.line, column: token.column };
  }

  // limit output to 400 lines [or 20 KB]: the most print output the agent sees, in AGENTS.talk or a policy
  // see src/md/infrastructure/host.md
  function parseOutputLimit(token) {
    i++;
    if (!isWord("to")) {
      error("Expected 'to'");
      return null;
    }
    i++;
    const limit = { type: "outputLimit", lines: null, bytes: null, line: token.line, column: token.column };
    while (true) {
      // a number token holds its digits as text
      const number = current();
      const value = number === undefined || number.type !== "number" ? NaN : Number(number.value);
      if (!Number.isInteger(value) || value < 1) {
        error("Expected a whole number above 0, such as: limit output to 400 lines");
        return null;
      }
      i++;
      if (isWord("lines") && limit.lines === null) {
        limit.lines = value;
      } else if ((isWord("KB") || isWord("kb")) && limit.bytes === null) {
        limit.bytes = value * 1024;
      } else {
        error("Expected 'lines' or 'KB', such as: limit output to 400 lines or 20 KB");
        return null;
      }
      i++;
      if (!isWord("or")) {
        break;
      }
      i++;
    }
    return limit;
  }

  // AGENTS.talk: only definitions at the top level
  function parseDefinitions() {
    const definitions = [];
    while (!atEnd()) {
      // limit output to ...: both AGENTS.talk and a policy can have it
      if (isWord("limit") && tokens[i + 1] !== undefined && tokens[i + 1].value === "output") {
        const token = current();
        i++;
        const definition = parseOutputLimit(token);
        if (definition !== null) {
          definitions.push(definition);
        } else {
          while (!atEnd() && !isWord("tool") && !isWord("allow") && !isWord("import") && !isWord("before") && !isWord("after") && !isWord("limit")) {
            i++;
          }
        }
        continue;
      }
      // keep audit for <n> days (AGENTS.talk), keep audit for at least <n> days (a policy); see src/md/features/audit.md
      if (isWord("keep")) {
        const token = current();
        i++;
        const definition = parseKeepAudit(token);
        if (definition !== null) {
          definitions.push(definition);
        }
        continue;
      }
      // a policy: policy 'name', require ..., limit ..., deny ..., audit also to ...; see src/md/features/policy.md
      if (isWord("policy") || isWord("require") || isWord("limit") || isWord("deny") || (isWord("audit") && tokens[i + 1] !== undefined && tokens[i + 1].value === "also")) {
        const token = current();
        if (!options.policy) {
          error("'" + token.value + "' is only allowed in a policy file");
          i++;
          while (!atEnd() && !isWord("tool") && !isWord("allow") && !isWord("import") && !isWord("before") && !isWord("after")) {
            i++;
          }
          continue;
        }
        i++;
        const definition = parsePolicyLine(token);
        if (definition !== null) {
          definitions.push(definition);
        } else {
          while (!atEnd() && !isWord("policy") && !isWord("require") && !isWord("limit") && !isWord("deny") && !isWord("audit") && !isWord("before") && !isWord("after")) {
            i++;
          }
        }
        continue;
      }
      // a policy has no tools, imports or allows: it sets limits; the user's AGENTS.talk has the tools
      if (options.policy && (isWord("tool") || isWord("import") || isWord("allow"))) {
        error("'" + current().value + "' is not allowed in a policy file: a policy sets limits, and AGENTS.talk has the tools");
        i++;
        while (!atEnd() && !isWord("policy") && !isWord("require") && !isWord("limit") && !isWord("deny") && !isWord("audit") && !isWord("before") && !isWord("after")) {
          i++;
        }
        continue;
      }
      if (isWord("use")) {
        const token = current();
        i++;
        const definition = parseUseModel(token);
        if (definition !== null) {
          definitions.push(definition);
        }
        continue;
      }
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
      // audit as json | audit as text: the format of the audit in talk/audit/
      if (isWord("audit")) {
        const token = current();
        i++;
        if (!isWord("as")) {
          error("Expected 'as json' or 'as text'");
          continue;
        }
        i++;
        if (!isWord("json") && !isWord("text")) {
          error("Expected 'as json' or 'as text'");
          continue;
        }
        definitions.push({ type: "audit", format: current().value, line: token.line, column: token.column });
        i++;
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
      // untrusted tool <name>: the tool's result is untrusted; see src/md/features/taint.md
      const untrusted = isWord("untrusted") && tokens[i + 1] !== undefined && tokens[i + 1].type === "word" && tokens[i + 1].value === "tool";
      if (untrusted) {
        i++;
      }
      if (isWord("tool")) {
        const token = current();
        i++;
        const definition = parseToolDefinition(token);
        if (definition !== null) {
          definition.untrusted = untrusted;
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

  try {
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
  } catch (err) {
    if (!err.tooDeep && !err.tooLong) {
      throw err;
    }
    const at = err.token || tokens[tokens.length - 1] || { line: 1, column: 1 };
    const message = err.tooDeep ? "The script nests more than " + MAX_NESTING + " levels deep" : "An expression has more than " + MAX_CHAIN + " parts in a row";
    errors.push({ message: message + ". Use variables for parts of it", line: at.line, column: at.column });
    return { script: options.definitions ? { type: "definitions", definitions: [] } : { type: "script", commands: [] }, errors };
  }
}
