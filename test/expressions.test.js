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

// parse "print <source>" and give back the expression
function expr(source) {
  const { script, errors } = parse("print " + source);
  assert.deepEqual(errors, []);
  return shape(script.commands[0].value);
}

function errors(source) {
  return parse("print " + source).errors.map((e) => e.message);
}

const x = { type: "variable", name: "x" };

test("true, false and null", () => {
  assert.deepEqual(expr("true"), { type: "boolean", value: true });
  assert.deepEqual(expr("false"), { type: "boolean", value: false });
  assert.deepEqual(expr("null"), { type: "null" });
});

test("it and result are the same special word", () => {
  assert.deepEqual(expr("it"), { type: "result" });
  assert.deepEqual(expr("result"), { type: "result" });
});

test("the is optional noise", () => {
  assert.deepEqual(expr("the x"), x);
  assert.deepEqual(expr("the result"), { type: "result" });
});

test("possessive and dot are the same", () => {
  const expected = { type: "property", object: x, name: "number" };
  assert.deepEqual(expr("x's number"), expected);
  assert.deepEqual(expr("x.number"), expected);
});

test("access chains", () => {
  assert.deepEqual(expr("the result's code"), {
    type: "property", object: { type: "result" }, name: "code",
  });
  assert.deepEqual(expr("a.b's c"), {
    type: "property",
    object: { type: "property", object: { type: "variable", name: "a" }, name: "b" },
    name: "c",
  });
});

test("index", () => {
  assert.deepEqual(expr("x[0]"), {
    type: "index", object: x, index: { type: "number", value: 0 },
  });
});

test("lists", () => {
  assert.deepEqual(expr("[]"), { type: "list", items: [] });
  assert.deepEqual(expr("[1, 'a', x]"), {
    type: "list",
    items: [{ type: "number", value: 1 }, { type: "string", value: "a" }, x],
  });
});

test("objects", () => {
  assert.deepEqual(expr("{}"), { type: "object", fields: [] });
  assert.deepEqual(expr("{name: 'x', 'two words': 2}"), {
    type: "object",
    fields: [
      { name: "name", value: { type: "string", value: "x" } },
      { name: "two words", value: { type: "number", value: 2 } },
    ],
  });
});

test("parentheses", () => {
  assert.deepEqual(expr("(x)"), x);
  assert.deepEqual(expr("([1])[0]"), {
    type: "index",
    object: { type: "list", items: [{ type: "number", value: 1 }] },
    index: { type: "number", value: 0 },
  });
});

test("unclosed list is an error", () => {
  assert.deepEqual(errors("[1, 2"), ["Expected ']'"]);
});

test("object field needs a colon", () => {
  assert.deepEqual(errors("{name 'x'}"), ["Expected ':'"]);
});

test("possessive needs a property name", () => {
  assert.deepEqual(errors("x's 'y'").slice(0, 1), ["Expected a property name"]);
});

test("the alone is an error", () => {
  assert.deepEqual(errors("the"), ["Expected a value"]);
});
