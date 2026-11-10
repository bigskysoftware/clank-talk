import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { highlight, highlightBash, highlightAudit, highlightJson, highlightMarkdown } from "../docs/highlight.js";

function plain(html) {
  return html.replace(/<[^>]+>/g, "").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}

test("the JSON and Markdown highlighters mark their parts, and keep every character", () => {
  const json = '{\n  "args": ["-y", 2, true],\n  "x": null\n}';
  const jsonHtml = highlightJson(json);
  assert.equal(plain(jsonHtml), json);
  assert.match(jsonHtml, /<span class="tok-keyword">&quot;args&quot;<\/span>:/);
  assert.match(jsonHtml, /<span class="tok-string">&quot;-y&quot;<\/span>/);
  assert.match(jsonHtml, /<span class="tok-number">2<\/span>/);
  const md = "## Tools\n\n- Use the `clank_talk` tool for **all** work.";
  const mdHtml = highlightMarkdown(md);
  assert.equal(plain(mdHtml), md);
  assert.match(mdHtml, /<span class="tok-keyword">## Tools<\/span>/);
  assert.match(mdHtml, /<span class="tok-path">`clank_talk`<\/span>/);
});

test("the bash highlighter marks keywords, strings, variables and comments, and keeps every character", () => {
  const code = "# bump\nfor f in ./config/*.json; do\n  v=$(jq -r '.version' \"$f\")\n  if [ \"$v\" -lt 2 ]; then echo $v#x; fi\ndone";
  const html = highlightBash(code);
  assert.equal(plain(html), code);
  assert.match(html, /<span class="tok-comment"># bump<\/span>/);
  assert.match(html, /<span class="tok-keyword">for<\/span> f <span class="tok-keyword">in<\/span>/);
  assert.match(html, /<span class="tok-string">'\.version'<\/span>/);
  assert.match(html, /<span class="tok-path">\$v<\/span>#x/);
  assert.match(html, /<span class="tok-number">2<\/span>/);
});

test("the audit highlighter colors the header, the script and each column of a step, and keeps every character", () => {
  const log = "== 10:42:01  script 12 (main)  done  4 steps ==\n  run_tests\n--\n10:42:01  replace  src/config.js  undo saved\n10:42:01  tool     run_tests";
  const html = highlightAudit(log);
  assert.equal(plain(html), log);
  assert.match(html, /<span class="tok-number">10:42:01<\/span>/);
  assert.match(html, /<span class="tok-keyword">replace<\/span>  <span class="tok-path">src\/config\.js<\/span><span class="tok-comment">  undo saved<\/span>/);
  assert.match(html, /<span class="tok-path">run_tests<\/span>$/);
});

test("the highlighter keeps every character of every docs example", () => {
  for (const file of ["docs/docs.md", "docs/index.md"]) {
    const docs = fs.readFileSync(file, "utf8");
    for (const block of docs.match(/```talk[^\n]*\n[\s\S]*?```/g)) {
      const code = block.slice(block.indexOf("\n") + 1, -3);
      assert.equal(plain(highlight(code)), code);
    }
  }
});

test("the highlighter colors by the language's own tokens", () => {
  const html = highlight("in @/src/a.js do # note\n  git commit [./a] with 'x'\nend\nfetch https://x.com/a?b=1\nprint [1]'s first < 2");
  assert.match(html, /<span class="tok-keyword">in<\/span> <span class="tok-path">@\/src\/a\.js<\/span> <span class="tok-keyword">do<\/span> <span class="tok-comment"># note<\/span>/);
  assert.match(html, /<span class="tok-keyword">git<\/span> <span class="tok-keyword">commit<\/span>/);
  assert.match(html, /<span class="tok-path">https:\/\/x\.com\/a\?b=1<\/span>/);
  assert.match(html, /\]<span class="tok-keyword">'s<\/span>/);
  assert.match(html, /&lt; <span class="tok-number">2<\/span>/);
});
