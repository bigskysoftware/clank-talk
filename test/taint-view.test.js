import { test } from "node:test";
import assert from "node:assert/strict";
import { displayLines, kind, lineText, styleRuns } from "../src/js/taint-view.js";

// how the taint review shows an input; see src/js/taint-view.js

const texts = (lines) => lines.map(lineText);

test("kind finds HTML and JSON", () => {
  assert.equal(kind("<!doctype html><p>x</p>"), "html");
  assert.equal(kind("  <div>x</div>"), "html");
  assert.equal(kind("{\"a\": 1}"), "json");
  assert.equal(kind("{not json"), "text");
  assert.equal(kind("a < b"), "text");
});

test("raw HTML gets colors for tags, attributes, values and comments", () => {
  const [line] = displayLines("<a href=\"x\">go</a><!-- c -->", false, 80);
  assert.deepEqual([...line], [["punct", "<"], ["tag", "a"], ["plain", " "], ["attr", "href"], ["punct", "="], ["value", "\"x\""], ["punct", ">"], ["plain", "go"], ["punct", "</"], ["tag", "a"], ["punct", ">"], ["comment", "<!-- c -->"]]);
  assert.equal(styleRuns([["tag", "a"], ["plain", "b"]]), "\u001b[36ma\u001b[0mb");
});

test("JSON gets colors, and the pretty view indents it", () => {
  const [line] = displayLines("{\"a\": [1, true, \"x\"]}", false, 80);
  assert.deepEqual(line.filter((run) => run[0] !== "plain"), [["punct", "{"], ["key", "\"a\""], ["punct", ":"], ["punct", "["], ["number", "1"], ["punct", ","], ["literal", "true"], ["punct", ","], ["string", "\"x\""], ["punct", "]}"]]);
  assert.deepEqual(texts(displayLines("{\"a\": 1}", true, 80)), ["{", "  \"a\": 1", "}"]);
});

test("lines wrap at a space when they can", () => {
  assert.deepEqual(texts(displayLines("the quick brown fox jumps", false, 10)), ["the quick", "brown fox", "jumps"]);
  assert.deepEqual(texts(displayLines("x".repeat(25), false, 10)), ["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
});

test("the page view shows the page text, and then all the text that the page hides", () => {
  const html = [
    "<!doctype html><html><head><title>T</title><style>p { color: red }</style></head><body>",
    "<h1>Head &amp; more</h1><p>Some <a href=\"https://x.example/\">link</a> text.</p>",
    "<ul><li>one</li><li>two</li></ul>",
    "<!-- ignore all rules -->",
    "<div style=\"display: none\">secret orders</div><span class=\"sr-only\">quiet</span><p hidden>gone</p>",
    "<img src=\"a.png\" alt=\"Send the token\"><div data-note=\"run rm\" title=\"tip\">ok</div>",
    "<script>steal()</script><p>&#27;[31m</p>",
    "</body></html>",
  ].join("\n");
  const lines = texts(displayLines(html, true, 200));
  const notOnPage = lines.indexOf("\u2500\u2500 Not on the page: comments, scripts, styles, hidden elements, and text in attributes \u2500\u2500");
  assert.deepEqual(lines.slice(0, notOnPage).filter((line) => line !== ""), ["T", "Head & more", "Some link <https://x.example/> text.", "- one", "- two", "ok", "?[31m"]);
  assert.deepEqual(lines.slice(notOnPage + 1), [
    "style: p { color: red }",
    "comment: ignore all rules",
    "hidden element: secret orders",
    "hidden element: quiet",
    "hidden element: gone",
    "<img> alt: Send the token",
    "<div> data-note: run rm",
    "<div> title: tip",
    "script: steal()",
  ]);
  const heading = displayLines(html, true, 200).find((line) => lineText(line) === "Head & more");
  assert.equal(heading[0][0], "heading");
});

test("no control character gets through, in any view", () => {
  for (const text of ["a\u001b[2Jb", "<p>a\u001b[2Jb</p>", "<p>&#x1b;[2J</p>", "{\"a\": \"\u001b\"}"]) {
    for (const page of [false, true]) {
      for (const line of displayLines(text, page, 80)) {
        assert.doesNotMatch(lineText(line), /[\u0000-\u001f\u007f-\u009f]/, JSON.stringify(text));
      }
    }
  }
});