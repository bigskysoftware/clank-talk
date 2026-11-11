// the install picker: pick an agent, see its setup, copy it
// on the home page it shows one code block; in the docs it shows one section (.harness)
const button = document.querySelector(".install-button");
const menu = document.querySelector(".install-menu");
const blocks = document.querySelectorAll(".install-code pre, .harness");
const copy = document.querySelector(".install-copy");

// simple highlighting for the shell, JSON and TOML snippets, with the site's token colors
function highlight(text) {
  const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed.startsWith("//")) {
      lines.push('<span class="tok-comment">' + escape(line) + "</span>");
      continue;
    }
    let html = escape(line);
    // strings, then a [table] header in TOML, then the command at the start of a shell line
    html = html.replace(/"[^"]*"/g, (s) => '<span class="tok-string">' + s + "</span>");
    html = html.replace(/^\[[^\]]+\]$/, (s) => '<span class="tok-keyword">' + s + "</span>");
    html = html.replace(/^(claude|npx|node|pi)\b/, '<span class="tok-keyword">$1</span>');
    lines.push(html);
  }
  return lines.join("\n");
}

for (const block of document.querySelectorAll(".install-code pre")) {
  const code = block.querySelector("code");
  code.innerHTML = highlight(code.textContent);
}

function open(isOpen) {
  menu.hidden = !isOpen;
  button.setAttribute("aria-expanded", String(isOpen));
}

function choose(item) {
  const agent = item.dataset.agent;
  for (const block of blocks) {
    block.hidden = block.dataset.agent !== agent;
  }
  button.querySelector(".agent-icon").replaceWith(item.querySelector(".agent-icon").cloneNode(true));
  // the name is the text after the icon
  button.querySelector(".install-name").textContent = item.lastChild.textContent.trim();
  open(false);
  button.focus();
}

button.addEventListener("click", () => open(menu.hidden));

for (const item of menu.querySelectorAll("li")) {
  item.addEventListener("click", () => choose(item));
  item.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(item);
    }
  });
}

document.addEventListener("click", (event) => {
  if (!event.target.closest(".install-picker")) {
    open(false);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    open(false);
  }
});

copy?.addEventListener("click", async () => {
  const block = document.querySelector(".install-code pre:not([hidden])");
  await navigator.clipboard.writeText(block.textContent);
  copy.textContent = "Copied";
  setTimeout(() => {
    copy.textContent = "Copy";
  }, 1500);
});
