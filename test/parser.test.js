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
