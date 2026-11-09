// Dev server: serves _site/, rebuilds when docs/ changes, tells the browser to reload
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execSync } from "node:child_process";

const PORT = 8000;
const OUT = path.resolve("_site");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const RELOAD_SCRIPT = '<script>new EventSource("/__reload").onmessage = () => location.reload();</script>';

// open browser connections waiting for a reload message
let clients = [];

function build() {
  try {
    execSync("node docs/build.js", { stdio: "ignore" });
    console.log("rebuilt");
  } catch (err) {
    console.log("build failed: " + err.message);
  }
}

function reloadClients() {
  for (const res of clients) {
    res.write("data: reload\n\n");
  }
}

function serveFile(req, res) {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath.endsWith("/")) {
    urlPath = urlPath + "index.html";
  }

  const file = path.join(OUT, urlPath);
  if (!file.startsWith(OUT)) {
    res.writeHead(403);
    res.end();
    return;
  }

  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end("not found");
    return;
  }

  const ext = path.extname(file);
  let body = fs.readFileSync(file);
  if (ext === ".html") {
    body = body.toString().replace("</body>", RELOAD_SCRIPT + "\n</body>");
  }

  res.writeHead(200, { "Content-Type": TYPES[ext] || "application/octet-stream" });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.url === "/__reload") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });
    clients.push(res);
    req.on("close", () => {
      clients = clients.filter((c) => c !== res);
    });
    return;
  }
  serveFile(req, res);
});

// wait a little after the last change, editors often write files more than once
let timer = null;
fs.watch("docs", { recursive: true }, () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    build();
    reloadClients();
  }, 100);
});

build();
server.listen(PORT, "127.0.0.1", () => {
  console.log("serving http://localhost:" + PORT + "/");
});
