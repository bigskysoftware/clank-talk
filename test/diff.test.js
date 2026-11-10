import { test } from "node:test";
import assert from "node:assert/strict";
import { changedFiles } from "../src/js/diff.js";

const text = (count, change = {}) => {
  const lines = [];
  for (let n = 1; n <= count; n++) {
    lines.push(change[n] !== undefined ? change[n] : "line " + n);
  }
  return lines.join("\n") + "\n";
};

test("one entry for each file: changed lines with numbers, 1 line of context, ... between", () => {
  const before = text(30);
  const after = text(30, { 5: "five", 25: "twenty-five" });
  assert.equal(changedFiles([{ path: "a.js", before, after }]), [
    "a.js",
    "   4  line 4",
    "-  5  line 5",
    "+  5  five",
    "   6  line 6",
    "  ...",
    "  24  line 24",
    "- 25  line 25",
    "+ 25  twenty-five",
    "  26  line 26",
  ].join("\n"));
});

test("added and removed lines get the right numbers", () => {
  const before = "a\nb\nc\n";
  const after = "a\nnew\nb\n";
  assert.equal(changedFiles([{ path: "x", before, after }]), ["x", "  1  a", "+ 2  new", "  3  b", "- 3  c"].join("\n"));
});

test("many writes to one file give one entry: the first before against the last after", () => {
  const changes = [
    { path: "a", before: "1\n", after: "2\n" },
    { path: "b", before: null, after: "x\ny\n" },
    { path: "a", before: "2\n", after: "3\n" },
    { path: "c", before: "same\n", after: "same\n" },
    { path: "d", before: "gone\n", after: null },
  ];
  assert.equal(changedFiles(changes), ["a", "- 1  1", "+ 1  3", "b  (new file, 2 lines)", "c  (no change)", "d  (removed)"].join("\n"));
});

test("a big change is cut: 20 changed lines for each file", () => {
  const before = text(100);
  const after = text(100, Object.fromEntries(Array.from({ length: 30 }, (_, i) => [i + 1, "x" + (i + 1)])));
  const out = changedFiles([{ path: "big", before, after }]).split("\n");
  assert.equal(out.filter((line) => /^[-+] /.test(line)).length, 20);
  assert.equal(out[out.length - 1], "  ... 40 more changed lines");
});

test("a wrong escape shows", () => {
  const out = changedFiles([{ path: "t.js", before: 'x = "a";\n', after: 'x = "a\\\\n";\n' }]);
  assert.match(out, /\+ 1  x = "a\\\\n";/);
});
