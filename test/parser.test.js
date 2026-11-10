import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/js/parser.js";

// drop line and column, so tests can compare the shape of the tree
function shape(node) {
  if (Array.isArray(node)) {
    return node.map(shape);
  }
  if (node !== null && typeof node === "object") {
    const result = {};
    for (const key of Object.keys(node)) {
      if (key !== "line" && key !== "column") {
        result[key] = shape(node[key]);
      }
    }
    return result;
  }
  return node;
}

function commands(source, options) {
  const { script, errors } = parse(source, options);
  assert.deepEqual(errors, []);
  return shape(script.commands);
}

function errors(source, options) {
  return parse(source, options).errors.map((e) => e.message + " @" + e.line + ":" + e.column);
}

test("empty script", () => {
  assert.deepEqual(commands(""), []);
});

test("print a value", () => {
  assert.deepEqual(commands("print 'hi' print 2 print ./a.txt print x"), [
    { type: "print", value: { type: "string", value: "hi" } },
    { type: "print", value: { type: "number", value: 2 } },
    { type: "print", value: { type: "path", value: "./a.txt" } },
    { type: "print", value: { type: "variable", name: "x" } },
  ]);
});

test("commands on separate lines", () => {
  assert.deepEqual(commands("print 1\nprint 2").length, 2);
});

test("then separates commands", () => {
  assert.deepEqual(commands("print 1 then print 2").length, 2);
});

test("if block", () => {
  assert.deepEqual(commands("if x\n  print 1\n  print 2\nend"), [
    {
      type: "if",
      condition: { type: "variable", name: "x" },
      body: [
        { type: "print", value: { type: "number", value: 1 } },
        { type: "print", value: { type: "number", value: 2 } },
      ],
      elseBody: [],
    },
  ]);
});

test("nested if blocks", () => {
  const [outer] = commands("if a\n  if b\n    print 1\n  end\nend");
  assert.equal(outer.body[0].type, "if");
  assert.equal(outer.body[0].body[0].type, "print");
});

test("missing end is an error", () => {
  assert.deepEqual(errors("if x\n  print 1"), ["Expected 'end' for the 'if' at line 1 @2:9"]);
});

test("stray end is an error", () => {
  assert.deepEqual(errors("print 1\nend\nprint 2"), ["Unexpected 'end' @2:1"]);
});

test("a known tool is a tool call", () => {
  assert.deepEqual(commands("run_tests", { tools: ["run_tests"] }), [
    { type: "toolCall", name: "run_tests", args: [], named: [], within: null },
  ]);
});

test("an unknown word is an error", () => {
  assert.deepEqual(errors("run_tests"), ["Unknown command 'run_tests' @1:1"]);
});

test("print with no value is an error", () => {
  assert.deepEqual(errors("print"), ["Expected a value @1:1"]);
  assert.deepEqual(errors("print end"), ["Expected a value @1:7", "Unexpected 'end' @1:7"]);
});

test("tokenizer errors are reported with parse errors", () => {
  assert.deepEqual(errors("print ~\nprint 'oops"), [
    "Unexpected character '~' @1:7",
    "Unterminated string @2:7",
    "Expected a value @2:1",
    "Expected a value @2:1",
  ]);
});

test("parsing goes on after an error", () => {
  const { script, errors } = parse("bogus 1 2\nprint 3");
  assert.equal(errors.length, 1);
  assert.deepEqual(shape(script.commands), [
    { type: "print", value: { type: "number", value: 3 } },
  ]);
});

test("commands keep their line and column", () => {
  const { script } = parse("\n  print 1");
  assert.equal(script.commands[0].line, 2);
  assert.equal(script.commands[0].column, 3);
});

test('git commands', () => {
  assert.deepEqual(commands("git status\ngit diff\ngit diff ./a.js\ngit log 20\ngit show 'abc'\ngit branches\ngit branch"), [
    { type: 'git', operation: 'status', value: null },
    { type: 'git', operation: 'diff', value: null },
    { type: 'git', operation: 'diff', value: { type: 'path', value: './a.js' } },
    { type: 'git', operation: 'log', value: { type: 'number', value: 20 } },
    { type: 'git', operation: 'show', value: { type: 'string', value: 'abc' } },
    { type: 'git', operation: 'branches', value: null },
    { type: 'git', operation: 'branch', value: null },
  ]);
});

test('git errors', () => {
  assert.deepEqual(errors('git rebase'), ['Expected a git operation: status, diff, log, show, branches, branch, switch, commit, merge, push, delete @1:5']);
  assert.deepEqual(errors('git show'), ['Expected a value @1:5']);
});

test('git switch and git commit', () => {
  assert.deepEqual(commands("git switch to 'x'\ngit switch to new branch 'y'\ngit commit ./a.js with 'msg'"), [
    { type: 'git', operation: 'switch', value: { type: 'string', value: 'x' }, create: false },
    { type: 'git', operation: 'switch', value: { type: 'string', value: 'y' }, create: true },
    { type: 'git', operation: 'commit', value: { type: 'path', value: './a.js' }, message: { type: 'string', value: 'msg' } },
  ]);
  assert.deepEqual(errors("git switch 'x'"), ["Expected 'to' @1:12"]);
  assert.deepEqual(errors("git commit ./a.js"), ["Expected 'with' and a message @1:12"]);
});

test('undo forms', () => {
  assert.deepEqual(commands("undo\nundo 3\nundo changes to ./a.js\nprint the undo list"), [
    { type: 'undo', count: null, file: null },
    { type: 'undo', count: { type: 'number', value: 3 }, file: null },
    { type: 'undo', count: null, file: { type: 'path', value: './a.js' } },
    { type: 'print', value: { type: 'undoList' } },
  ]);
});

test('ask', () => {
  const [plain, choice] = commands("ask 'Name?'\nask 'Push?' with 'yes' or 'no' within 5 minutes");
  assert.deepEqual(plain, { type: 'ask', question: { type: 'string', value: 'Name?' }, choices: [], within: null });
  assert.deepEqual(choice.choices, [{ type: 'string', value: 'yes' }, { type: 'string', value: 'no' }]);
  assert.equal(choice.within.ms, 60000);
  assert.deepEqual(errors("ask 'x' with 'a'"), ["Expected 'or' and a second choice @1:14"]);
});

test('fetch', () => {
  const [plain, full] = commands("fetch 'https://x.com'\nfetch url as json with method: 'POST', body: {a: 1} within 5 seconds");
  assert.deepEqual(plain, { type: 'fetch', url: { type: 'string', value: 'https://x.com' }, as: 'text', named: [], within: null });
  assert.equal(full.as, 'json');
  assert.deepEqual(full.named.map((n) => n.name), ['method', 'body']);
  assert.equal(full.within.ms, 1000);
  assert.deepEqual(errors("fetch 'x' as html"), ['Expected json, response or text @1:14']);
});

test('wait, wait until, and fetch as a value', () => {
  const [plain, until] = commands("wait 2 seconds\nwait until (fetch 'http://x' as response)'s status is 200 within 10 seconds");
  assert.equal(plain.type, 'wait');
  assert.equal(plain.duration.ms, 1000);
  assert.equal(until.type, 'waitUntil');
  assert.equal(until.condition.left.object.type, 'fetch');
  assert.equal(until.condition.left.object.as, 'response');
  assert.equal(until.within.ms, 1000);
});

test('in <target> replace and find mean the same as the target last', () => {
  assert.deepEqual(commands("in ./a.js\n  replace 'x' with 'y'"), commands("replace 'x' with 'y' in ./a.js"));
  assert.deepEqual(commands("in ./src/*.js find 'TODO'"), commands("find 'TODO' in ./src/*.js"));
  assert.deepEqual(errors("in ./a.js print 1"), ["Expected replace, find or do after 'in <file>' @1:11"]);
  assert.deepEqual(errors("in ./a.js replace 'x' with 'y' in ./b.js"), ["Expected replace, find or do after 'in <file>' @1:35"]);
  assert.equal(commands("in ./a.js replace 'x' with 'y'\nin ./b.js find 'z'").length, 2);
  assert.match(errors("in ./a.js replace lines 1 to 2 of ./a.js with 'x'")[0], /^Use 'replace lines/);
});

test("'in' as a command does not change other uses of in", () => {
  assert.equal(commands("for x in [1]\nend")[0].type, 'for');
  assert.equal(commands("print 1 is in [1]")[0].value.type, 'binary');
});

test('in <target> do ... end', () => {
  const [block] = commands("in ./a.js do\n  replace 'x' with 'y'\n  find 'z'\nend");
  assert.equal(block.type, 'do');
  assert.deepEqual(block.body.map((c) => c.target), [{ type: 'path', value: './a.js' }, { type: 'path', value: './a.js' }]);
  assert.match(errors("in ./a.js do\n  replace 'x' with 'y'")[0], /Expected 'end'/);
});

test("names from Object.prototype are not commands", () => {
  for (const word of ["__proto__", "hasOwnProperty", "constructor", "toString"]) {
    assert.deepEqual(parse(word).errors.map((e) => e.message), ["Unknown command '" + word + "'"], word);
  }
});

test("a script that nests too deep is an error, not a stack overflow", () => {
  const deep = "print " + "(".repeat(5000) + "1" + ")".repeat(5000);
  assert.match(parse(deep).errors[0].message, /^The script nests more than 100 levels deep/);
  const blocks = "if true\n".repeat(200) + "print 1\n" + "end\n".repeat(200);
  assert.match(parse(blocks).errors[0].message, /^The script nests more than 100 levels deep/);
  assert.deepEqual(parse("print " + "(".repeat(50) + "1" + ")".repeat(50)).errors, []);
});

test("an in block on the line after a line edit is a new command", () => {
  const source = "replace lines 1 to 1 of ./a.txt with 'x'\nin ./a.txt do\n  find 'two'\nend";
  const { script, errors } = parse(source);
  assert.deepEqual(errors, []);
  assert.equal(script.commands.length, 2);
  assert.equal(script.commands[0].type, "replaceLines");
});

test("a command word as a name gives an error that names the fix", () => {
  assert.deepEqual(errors("set stop to 5"), ["'stop' is a command word, so it cannot be a name. Use another name, such as 'my_stop', or write 'the stop' @1:5"]);
  assert.deepEqual(errors("increment find"), ["'find' is a command word, so it cannot be a name. Use another name, such as 'my_find', or write 'the find' @1:11"]);
  assert.equal(errors("set x to 1\nprint stop")[0], "Expected a value, found the command word 'stop'. If it is a name, write 'the stop' @2:7");
  assert.deepEqual(errors("set the stop to 5\nprint the stop"), []);
});
