import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/js/parser.js";

// write an expression tree as a short string, with parentheses around each operator,
// so tests show the grouping clearly
function show(node) {
  if (node.type === "binary") {
    return "(" + show(node.left) + " " + node.operator + " " + show(node.right) + ")";
  }
  if (node.type === "unary") {
    return "(" + node.operator + " " + show(node.value) + ")";
  }
  if (node.type === "check") {
    return "(" + show(node.value) + " " + node.operator + ")";
  }
  if (node.type === "conversion") {
    return "(" + show(node.value) + " as " + node.to + ")";
  }
  if (node.type === "variable") {
    return node.name;
  }
  if (node.type === "property") {
    return show(node.object) + "." + node.name;
  }
  if (node.type === "string") {
    return "'" + node.value + "'";
  }
  return String(node.value);
}

function expr(source) {
  const { script, errors } = parse("print " + source);
  assert.deepEqual(errors, []);
  return show(script.commands[0].value);
}

function errors(source) {
  return parse("print " + source).errors.map((e) => e.message);
}

test("math", () => {
  assert.equal(expr("a + b"), "(a + b)");
  assert.equal(expr("a + b + c"), "((a + b) + c)");
  assert.equal(expr("a mod 2"), "(a mod 2)");
});

test("mixing math operators needs parentheses", () => {
  assert.deepEqual(errors("1 + 2 * 3"), ["Mixing '+' and '*' needs parentheses"]);
  assert.equal(expr("1 + (2 * 3)"), "(1 + (2 * 3))");
});

test("unary", () => {
  assert.equal(expr("not a"), "(not a)");
  assert.equal(expr("no a"), "(no a)");
  assert.equal(expr("-a"), "(- a)");
  assert.equal(expr("not not a"), "(not (not a))");
});

test("unary binds tighter than math", () => {
  assert.equal(expr("-a + b"), "((- a) + b)");
});

test("conversion", () => {
  assert.equal(expr("x as json"), "(x as json)");
  assert.equal(expr("the file's text as json"), "(file.text as json)");
  assert.deepEqual(errors("x as banana"), ["Expected one of: json, number, text"]);
});

test("conversion binds tighter than math", () => {
  assert.equal(expr("a as number + 1"), "((a as number) + 1)");
});

test("comparison words", () => {
  assert.equal(expr("a is b"), "(a is b)");
  assert.equal(expr("a is not b"), "(a is not b)");
  assert.equal(expr("a is less than b"), "(a is less than b)");
  assert.equal(expr("a is greater than b"), "(a is greater than b)");
  assert.equal(expr("a is less than or equal to b"), "(a is less than or equal to b)");
  assert.equal(expr("a is greater than or equal to b"), "(a is greater than or equal to b)");
});

test("comparison symbols give the same operators as words", () => {
  assert.equal(expr("a == b"), "(a is b)");
  assert.equal(expr("a != b"), "(a is not b)");
  assert.equal(expr("a < b"), "(a is less than b)");
  assert.equal(expr("a > b"), "(a is greater than b)");
  assert.equal(expr("a <= b"), "(a is less than or equal to b)");
  assert.equal(expr("a >= b"), "(a is greater than or equal to b)");
});

test("text and list operators", () => {
  assert.equal(expr("a contains 'x'"), "(a contains 'x')");
  assert.equal(expr("a does not contain 'x'"), "(a does not contain 'x')");
  assert.equal(expr("a starts with 'x'"), "(a starts with 'x')");
  assert.equal(expr("a ends with 'x'"), "(a ends with 'x')");
  assert.equal(expr("a is in b"), "(a is in b)");
  assert.equal(expr("a is not in b"), "(a is not in b)");
});

test("checks have no right side", () => {
  assert.equal(expr("a exists"), "(a exists)");
  assert.equal(expr("a does not exist"), "(a does not exist)");
  assert.equal(expr("a is empty"), "(a is empty)");
  assert.equal(expr("a is not empty"), "(a is not empty)");
});

test("math binds tighter than comparison", () => {
  assert.equal(expr("a + 1 is less than b"), "((a + 1) is less than b)");
});

test("logic", () => {
  assert.equal(expr("a and b and c"), "((a and b) and c)");
  assert.equal(expr("a is 1 or b is 2"), "((a is 1) or (b is 2))");
});

test("mixing and with or needs parentheses", () => {
  assert.deepEqual(errors("a and b or c"), ["Mixing 'and' and 'or' needs parentheses"]);
  assert.equal(expr("a and (b or c)"), "(a and (b or c))");
});

test("the hero example condition", () => {
  assert.equal(expr("the file's text contains 'var '"), "(file.text contains 'var ')");
});

test("the hook example condition", () => {
  assert.equal(expr("the write's path ends with '.env'"), "(write.path ends with '.env')");
});

test("an expression stops at the next command", () => {
  const { script, errors } = parse("if a is 1 print 'yes' end");
  assert.deepEqual(errors, []);
  assert.equal(show(script.commands[0].condition), "(a is 1)");
});

test("incomplete operators are errors", () => {
  assert.deepEqual(errors("a is less b"), ["Expected 'than'"]);
  assert.deepEqual(errors("a starts 'x'"), ["Expected 'with'"]);
  assert.deepEqual(errors("a does contain 'x'"), ["Expected 'not'"]);
});
