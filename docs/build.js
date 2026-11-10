// Builds the site from docs/ into _site/
// .md files go through template.html, everything else is copied as is
import fs from "node:fs";
import path from "node:path";
import { marked } from "marked";
import { highlight } from "./highlight.js";
import { referenceMarkdown } from "../src/js/help.js";

const SRC = "docs";
const OUT = "_site";
const SKIP = ["build.js", "highlight.js", "serve.js", "template.html"];

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ```talk blocks get highlighted
// a title after the language puts the block in a window: ```talk bump.talk
marked.use({
  renderer: {
    code(token) {
      const parts = (token.lang || "").trim().split(/\s+/);
      const lang = parts[0];
      const title = parts.slice(1).join(" ");
      if (lang !== "talk" && title === "") {
        return false;
      }
      let code;
      if (lang === "talk") {
        code = '<pre><code class="language-talk">' + highlight(token.text) + "</code></pre>\n";
      } else {
        code = '<pre><code class="language-' + escapeHtml(lang) + '">' + escapeHtml(token.text) + "</code></pre>\n";
      }
      if (title === "") {
        return code;
      }
      return '<div class="window">\n<div class="window-title">' + escapeHtml(title) + "</div>\n" + code + "</div>\n";
    },
  },
});

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT);

const template = fs.readFileSync(path.join(SRC, "template.html"), "utf8");

// a page from Markdown, in the template
function page(md, outName) {
  let title = "clank-talk";
  const heading = md.match(/^# (.+)$/m);
  if (heading) {
    title = heading[1] + " - clank-talk";
  }
  // split/join so that "$" in content is not treated as a replace pattern
  let html = template.split("{{title}}").join(title);
  html = html.split("{{content}}").join(marked.parse(md));
  fs.writeFileSync(path.join(OUT, outName), html);
  console.log("page: " + outName);
}

// the reference is made from the help table, so it always agrees with help
page('<div class="features">\n\n<p><a href="./">Home</a> | <a href="docs.html">Docs for Humans</a> | <a href="https://github.com/bigskysoftware/clank-talk">GitHub</a></p>\n\n' + referenceMarkdown() + "\n\n</div>\n", "reference.html");

for (const name of fs.readdirSync(SRC)) {
  if (SKIP.includes(name)) {
    continue;
  }

  const src = path.join(SRC, name);

  if (name.endsWith(".md")) {
    page(fs.readFileSync(src, "utf8"), name.replace(/\.md$/, ".html"));
  } else {
    fs.cpSync(src, path.join(OUT, name), { recursive: true });
    console.log("copy: " + name);
  }
}
