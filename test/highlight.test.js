import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { highlight } from "../docs/highlight.js";

function plain(html) {
  return html.replace(/<[^>]+>/g, "").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}

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
