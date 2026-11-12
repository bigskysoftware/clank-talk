// One untrusted input as a static, read-only HTML page: npx clank-talk taint show --html <ref>
// See src/md/features/taint.md. The page has no script and approves nothing.
// The input's own HTML renders only in a sandboxed iframe, with a CSP that blocks scripts and all loads.

import fs from "node:fs/promises";
import nodePath from "node:path";
import { execFile } from "node:child_process";
import { kind, viewText } from "./taint-view.js";
import * as untrusted from "./untrusted.js";

// write the page of one input next to it in the store: .talk/untrusted/<session>/<n>.html; gives the file
export async function writePage(root, session, entry, info) {
  const stored = await untrusted.inputText(root, session, entry);
  // the store keeps the source and the time first, then a blank line, then the text
  const start = stored.indexOf("\n\n");
  const body = start === -1 ? stored : stored.slice(start + 2);
  const file = nodePath.join(root, untrusted.storePath(session), entry.n + ".html");
  await fs.writeFile(file, inputPage(info, body));
  return file;
}

// open a file in the browser, with the system's own opener; the path is one argument, never shell text
export function openFile(file) {
  const [program, args] = process.platform === "darwin" ? ["open", [file]] : process.platform === "win32" ? ["explorer.exe", [file]] : ["xdg-open", [file]];
  return new Promise((resolve) => execFile(program, args, () => resolve()));
}

// the text as HTML text or an attribute value
function escape(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// the lines with numbers, as the TUI shows them
function numbered(lines) {
  const digits = String(lines.length).length;
  return lines.map((line, index) => '<span class="n">' + String(index + 1).padStart(digits) + "</span> " + escape(line)).join("\n");
}

// the policy inside the iframe: no script, no fetch, no image or font from the network, no form
const FRAME_POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'";
// the policy of the page itself: no script and no load, only its own style and the iframe's srcdoc
const PAGE_POLICY = "default-src 'none'; style-src 'unsafe-inline'; frame-src 'self' about:; form-action 'none'; base-uri 'none'";

/**
 * The page for one input.
 * @param {{ ref: string, status: string, time: string, source: string, judge: string }} info
 * @param {string} body  the input's text, without the store's header lines
 */
export function inputPage(info, body) {
  const type = kind(body);
  // printable: control characters show as ?, so they cannot hide text
  const text = untrusted.printable(body, true);
  const views = [];
  views.push(["Text view" + (type === "html" ? ": the page as text, then what it hides" : type === "json" ? ": pretty" : ""), "<pre>" + numbered(viewText(text, true)) + "</pre>"]);
  views.push(["Raw", "<pre>" + numbered(text.split("\n")) + "</pre>"]);
  if (type === "html") {
    const frame = '<meta http-equiv="Content-Security-Policy" content="' + FRAME_POLICY + '">' + text;
    views.push(["Rendered (sandboxed: no scripts, no network; CSS can still hide or fake text, so read the text view too)", '<iframe sandbox="" referrerpolicy="no-referrer" srcdoc="' + escape(frame) + '"></iframe>']);
  }
  const rows = [["ref", info.ref], ["status", info.status], ["time", info.time], ["source", info.source], ["judge", info.judge]];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${PAGE_POLICY}">
<meta name="referrer" content="no-referrer">
<title>Untrusted input ${escape(info.ref)}</title>
<style>
  :root { color-scheme: light dark; --dim: #888; --line: #8884; }
  body { font: 14px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 110ch; padding: 16px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  table { border-collapse: collapse; margin-bottom: 16px; }
  td { padding: 2px 12px 2px 0; vertical-align: top; overflow-wrap: anywhere; }
  td:first-child { color: var(--dim); }
  details { border-top: 1px solid var(--line); padding: 8px 0; }
  summary { cursor: pointer; font-weight: 600; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.45 ui-monospace, monospace; }
  .n { color: var(--dim); user-select: none; }
  iframe { width: 100%; height: 70vh; border: 1px solid var(--line); background: #fff; }
</style>
</head>
<body>
<h1>Untrusted input ${escape(info.ref)}</h1>
<table>${rows.map(([name, value]) => "<tr><td>" + name + "</td><td>" + escape(value) + "</td></tr>").join("")}</table>
${views.map(([title, content], index) => "<details" + (index === 0 ? " open" : "") + "><summary>" + escape(title) + "</summary>" + content + "</details>").join("\n")}
</body>
</html>
`;
}
