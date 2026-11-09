import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize } from "../src/tokenizer.js";

// most tests only care about type and value
function simple(source) {
  return tokenize(source).map((t) => t.type + ":" + t.value);
}

test("words", () => {
  assert.deepEqual(simple("set config to x"), ["word:set", "word:config", "word:to", "word:x"]);
});

test("numbers", () => {
  assert.deepEqual(simple("2 3.5"), ["number:2", "number:3.5"]);
});

test("a dot after a number without digits is an op", () => {
  assert.deepEqual(simple("2."), ["number:2", "op:."]);
});

test("single and double quoted strings", () => {
  assert.deepEqual(simple("'var ' \"let \""), ["string:var ", "string:let "]);
});

test("string escapes", () => {
  assert.deepEqual(simple("'it\\'s' 'a\\nb'"), ["string:it's", "string:a\nb"]);
});

test("unterminated string is an error", () => {
  assert.throws(() => tokenize("say 'oops"), /Unterminated string at line 1, column 10/);
});

test("paths", () => {
  assert.deepEqual(simple("for file in ./src/**/*.js"), [
    "word:for", "word:file", "word:in", "path:./src/**/*.js",
  ]);
  assert.deepEqual(simple("../../etc/hosts"), ["path:../../etc/hosts"]);
});

test("project root paths", () => {
  assert.deepEqual(simple("@/src/app.js"), ["path:@/src/app.js"]);
});

test("a path ends at whitespace, ) or ,", () => {
  assert.deepEqual(simple("f(./a.json, ./b.json)"), [
    "word:f", "op:(", "path:./a.json", "op:,", "path:./b.json", "op:)",
  ]);
});

test("quoted paths can hold spaces", () => {
  assert.deepEqual(simple('read ./"my notes/todo list.txt" now'), [
    "word:read", "path:./my notes/todo list.txt", "word:now",
  ]);
  assert.deepEqual(simple('@/"a b"'), ["path:@/a b"]);
});

test("unterminated quoted path is an error", () => {
  assert.throws(() => tokenize('read ./"oops'), /Unterminated path/);
});

test("@ without / is an error", () => {
  assert.throws(() => tokenize("@x"), /Unexpected character '@'/);
});

test("underscores group digits", () => {
  assert.deepEqual(simple("1_000_000 2_5.0_1"), ["number:1000000", "number:25.01"]);
});

test("negative numbers", () => {
  assert.deepEqual(simple("set x to -3"), ["word:set", "word:x", "word:to", "number:-3"]);
  assert.deepEqual(simple("f(-1, -2.5)"), ["word:f", "op:(", "number:-1", "op:,", "number:-2.5", "op:)"]);
});

test("minus that touches a value is subtraction", () => {
  assert.deepEqual(simple("x-3"), ["word:x", "op:-", "number:3"]);
  assert.deepEqual(simple("x - 3"), ["word:x", "op:-", "number:3"]);
});

test("possessive", () => {
  assert.deepEqual(simple("the file's text"), ["word:the", "word:file", "possessive:'s", "word:text"]);
});

test("a quote after a space starts a string, not a possessive", () => {
  assert.deepEqual(simple("say 'sun'"), ["word:say", "string:sun"]);
});

test("# starts a comment to the end of the line", () => {
  assert.deepEqual(simple("# a comment\nsay 1 # another\nsay 2"), ["word:say", "number:1", "word:say", "number:2"]);
});

test("-- is not a comment", () => {
  assert.deepEqual(simple("x -- y"), ["word:x", "op:-", "op:-", "word:y"]);
});

test("operators", () => {
  assert.deepEqual(simple("f(a, b) + 1"), [
    "word:f", "op:(", "word:a", "op:,", "word:b", "op:)", "op:+", "number:1",
  ]);
});

test("unexpected character is an error", () => {
  assert.throws(() => tokenize("say ~"), /Unexpected character '~' at line 1, column 5/);
});

test("line and column", () => {
  const tokens = tokenize("if x\n  say 1");
  assert.deepEqual(tokens.map((t) => [t.value, t.line, t.column]), [
    ["if", 1, 1], ["x", 1, 4], ["say", 2, 3], ["1", 2, 7],
  ]);
});

test("the hero example", () => {
  const source = [
    "for file in ./src/**/*.js",
    "  if the file's text contains 'var '",
    "    replace it with 'let '",
    "  end",
    "end",
  ].join("\n");
  assert.deepEqual(simple(source), [
    "word:for", "word:file", "word:in", "path:./src/**/*.js",
    "word:if", "word:the", "word:file", "possessive:'s", "word:text", "word:contains", "string:var ",
    "word:replace", "word:it", "word:with", "string:let ",
    "word:end",
    "word:end",
  ]);
});
