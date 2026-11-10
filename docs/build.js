// Builds the site from docs/ into _site/
// .md files go through template.html, everything else is copied as is
import fs from "node:fs";
import path from "node:path";
import { marked } from "marked";
import { highlight, highlightBash, highlightAudit } from "./highlight.js";
import { referenceMarkdown } from "../src/js/help.js";

const SRC = "docs";
const OUT = "_site";
const SKIP = ["build.js", "highlight.js", "serve.js", "template.html"];

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ```talk, ```bash and ```audit blocks get highlighted
// a title after the language puts the block in a window: ```talk bump.talk
marked.use({
  renderer: {
    code(token) {
      const parts = (token.lang || "").trim().split(/\s+/);
      const lang = parts[0];
      const title = parts.slice(1).join(" ");
      if (lang !== "talk" && lang !== "bash" && lang !== "audit" && title === "") {
        return false;
      }
      let code;
      if (lang === "talk") {
        code = '<pre><code class="language-talk">' + highlight(token.text) + "</code></pre>\n";
      } else if (lang === "bash") {
        code = '<pre><code class="language-bash">' + highlightBash(token.text) + "</code></pre>\n";
      } else if (lang === "audit") {
        code = '<pre><code class="language-audit">' + highlightAudit(token.text) + "</code></pre>\n";
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

// the home page shows features two to a row: in a "showcase", each ## section becomes a card in a grid
// a section with no code window spans the whole row
// the under-construction box and what follows it stay out of the grid
function showcase(html) {
  const cut = html.indexOf('<div class="construction">');
  const body = cut === -1 ? html : html.slice(0, cut);
  const tail = cut === -1 ? "" : html.slice(cut);
  const parts = body.split(/(?=<h2)/);
  let out = parts[0] + '<div class="feature-grid">\n';
  const cards = parts.slice(1);
  // cards in a row since the last wide card; a last card with no pair goes in the center
  let inRow = 0;
  cards.forEach((part, index) => {
    const wide = !part.includes('class="window"');
    inRow = wide ? 0 : inRow + 1;
    const alone = !wide && index === cards.length - 1 && inRow % 2 === 1;
    out += '<section class="feature' + (wide ? " feature-wide" : "") + (alone ? " feature-alone" : "") + '">\n' + part + "</section>\n";
  });
  return out + "</div>\n" + tail;
}

// a page from Markdown, in the template
function page(md, outName) {
  let content = marked.parse(md);
  // the title is the first h1 of the page, so a "# comment" in a code block cannot become the title
  let title = "clank-talk";
  const heading = content.match(/<h1[^>]*>(.*?)<\/h1>/);
  if (heading) {
    title = heading[1].replace(/<[^>]+>/g, "") + " - clank-talk";
  }
  // split/join so that "$" in content is not treated as a replace pattern
  let html = template.split("{{title}}").join(title);
  if (md.includes('class="features showcase"')) {
    content = showcase(content);
  }
  html = html.split("{{content}}").join(content);
  fs.writeFileSync(path.join(OUT, outName), html);
  console.log("page: " + outName);
}

// the reference is made from the help table, so it always agrees with help
page('<div class="features">\n\n<img class="page-robot" src="img/clanktalk-robot.png" alt="A friendly robot">\n\n<p><a href="./">Home</a> | <a href="docs.html">Docs for Humans</a> | <a href="https://github.com/bigskysoftware/clank-talk">GitHub</a> | <a href="https://github.com/sponsors/bigskysoftware">Sponsor</a></p>\n\n' + referenceMarkdown() + "\n\n</div>\n", "reference.html");

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
