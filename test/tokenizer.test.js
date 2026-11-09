import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize } from "../src/js/tokenizer.js";

// most tests only care about type and value
function simple(source) {
  return tokenize(source).map((t) => t.type + ":" + t.value);
}

test("words", () => {
  assert.deepEqual(simple("set config to x"), ["word:set", "word:config", "word:to", "word:x"]);
});

test("global variables", () => {
  assert.deepEqual(simple("set $last to x"), ["word:set", "word:$last", "word:to", "word:x"]);
});

test("$ alone is an error", () => {
  assert.deepEqual(simple("$ 1"), ["error:Unexpected character '$'", "number:1"]);
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

test("unterminated string is an error token", () => {
  const tokens = tokenize("say 'oops");
  assert.deepEqual(tokens[1], { type: "error", value: "Unterminated string", line: 1, column: 5 });
});

test("tokenizing goes on after an error", () => {
  assert.deepEqual(simple("say ~ 2 'oops\nsay 3"), [
    "word:say", "error:Unexpected character '~'", "number:2", "error:Unterminated string",
  ]);
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

test("a path ends at a possessive", () => {
  assert.deepEqual(simple("./a.txt's lines"), ["path:./a.txt", "possessive:'s", "word:lines"]);
});

test("quoted paths can hold spaces", () => {
  assert.deepEqual(simple('read ./"my notes/todo list.txt" now'), [
    "word:read", "path:./my notes/todo list.txt", "word:now",
  ]);
  assert.deepEqual(simple('@/"a b"'), ["path:@/a b"]);
});

test("unterminated quoted path is an error token", () => {
  const tokens = tokenize('read ./"oops');
  assert.deepEqual(tokens[1], { type: "error", value: "Unterminated path", line: 1, column: 6 });
});

test("@ without / is an error token", () => {
  assert.deepEqual(simple("@x"), ["error:Unexpected character '@'", "word:x"]);
});

test("underscores group digits", () => {
  assert.deepEqual(simple("1_000_000 2_5.0_1"), ["number:1000000", "number:25.01"]);
});

test("negative numbers", () => {
  assert.deepEqual(simple("set x to -3"), ["word:set", "word:x", "word:to", "number:-3"]);
  assert.deepEqual(simple("f(-1, -2.5)"), ["word:f", "op:(", "number:-1", "op:,", "number:-2.5", "op:)"]);
});

test("negative numbers after ( [ { , = :", () => {
  assert.deepEqual(simple("[-1]"), ["op:[", "number:-1", "op:]"]);
  assert.deepEqual(simple("{-1}"), ["op:{", "number:-1", "op:}"]);
  assert.deepEqual(simple("x=-1"), ["word:x", "op:=", "number:-1"]);
  assert.deepEqual(simple("a:-1"), ["word:a", "op::", "number:-1"]);
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

test("two character operators", () => {
  assert.deepEqual(simple("a == b != c <= d >= e < f"), [
    "word:a", "op:==", "word:b", "op:!=", "word:c", "op:<=", "word:d", "op:>=", "word:e", "op:<", "word:f",
  ]);
});

test("unexpected character is an error token", () => {
  const tokens = tokenize("say ~");
  assert.deepEqual(tokens[1], { type: "error", value: "Unexpected character '~'", line: 1, column: 5 });
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

test("a path ends at an unmatched ] or }, but a glob keeps its brackets", () => {
  assert.deepEqual(simple("[./a, ./b]"), ["op:[", "path:./a", "op:,", "path:./b", "op:]"]);
  assert.deepEqual(simple("{f: ./a}"), ["op:{", "word:f", "op::", "path:./a", "op:}"]);
  assert.deepEqual(simple("./src/[ab].js ./src/*.{js,ts}"), ["path:./src/[ab].js", "path:./src/*.{js", "op:,", "word:ts", "op:}"]);
});

test("'s after ], } and ) is a possessive", () => {
  assert.deepEqual(simple("[1]'s x"), ["op:[", "number:1", "op:]", "possessive:'s", "word:x"]);
  assert.deepEqual(simple("{}'s x (y)'s z"), ["op:{", "op:}", "possessive:'s", "word:x", "op:(", "word:y", "op:)", "possessive:'s", "word:z"]);
});
