// npm run package-test: pack the package, install it in an empty folder, and run the CLI and the MCP server from it
// it finds files that the package leaves out; it publishes nothing; see src/md/infrastructure/release.md

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "..");
const version = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version;
const work = fs.mkdtempSync(path.join(os.tmpdir(), "clank-package-test-"));
const app = path.join(work, "app");
let failed = 0;

function check(name, ok, detail = "") {
  console.log((ok ? "ok    " : "FAIL  ") + name + (ok || detail === "" ? "" : ": " + detail));
  if (!ok) {
    failed++;
  }
}

function sh(program, args, cwd) {
  return execFileSync(program, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// one MCP request and its answer, over the server's stdin and stdout
function mcp(requests) {
  return new Promise((resolve, reject) => {
    const server = spawn("npx", ["--no-install", "clank-talk-mcp"], { cwd: app, env: { ...process.env, CLANK_TALK_ROOT: app } });
    const answers = new Map();
    let buffer = "";
    const timer = setTimeout(() => {
      server.kill();
      reject(new Error("the MCP server gave no answer within 20 s"));
    }, 20_000);
    server.stdout.on("data", (data) => {
      buffer += data;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (line !== "") {
          const message = JSON.parse(line);
          answers.set(message.id, message);
        }
      }
      if (requests.every((request) => request.id === undefined || answers.has(request.id))) {
        clearTimeout(timer);
        server.kill();
        resolve(answers);
      }
    });
    for (const request of requests) {
      server.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...request }) + "\n");
    }
  });
}

try {
  // the package, as npm would publish it
  const packed = sh("npm", ["pack", "--pack-destination", work], repo).trim().split("\n").pop();
  const tarball = path.join(work, packed);
  check("npm pack", fs.existsSync(tarball), packed);
  const files = sh("tar", ["-tzf", tarball], work).split("\n");
  for (const file of fs.readdirSync(path.join(repo, "src/js"), { recursive: true })) {
    if (file.endsWith(".js")) {
      check("the package has src/js/" + file, files.includes("package/src/js/" + file));
    }
  }

  // an empty project that installs it, with one tool
  fs.mkdirSync(app);
  sh("npm", ["init", "-y"], app);
  sh("npm", ["install", "--no-audit", "--no-fund", tarball], app);
  fs.writeFileSync(path.join(app, "AGENTS.talk"), "allow env PATH\n\n# Runs the tests.\ntool run_tests\n  run 'node --version' keeping the last 1 lines\nend\n");

  // the command line
  check("clank-talk taint --line", sh("npx", ["--no-install", "clank-talk", "taint", "--line", "--root", app], app).trim() === "untainted");

  // the MCP server
  const script = "# Package test\nwrite 'one' to ./notes.txt\nprint first of lines of ./notes.txt\nprint 'v12' matches pattern /^v[0-9]+/\nrun_tests\nprint it's code\nundo\nprint ./notes.txt exists\nhelp keeping";
  const answers = await mcp([
    { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "package-test", version: "0" } } },
    { method: "notifications/initialized" },
    { id: 2, method: "tools/list", params: {} },
    { id: 3, method: "tools/call", params: { name: "clank_talk", arguments: { script } } },
  ]);
  const server = answers.get(1).result.serverInfo;
  check("the server version is " + version, server.version === version, server.version);
  const tools = answers.get(2).result.tools;
  check("the tool list has clank_talk, with run_tests in its description", tools.length === 1 && tools[0].name === "clank_talk" && tools[0].description.includes("run_tests"));
  const call = answers.get(3).result;
  const text = call.content[0].text;
  check("a script runs with no error", call.isError === false, text);
  check("write, read, pattern, tool, undo and help work", /^one\ntrue\n0\nfalse\nrun <program/.test(text), text.slice(0, 200));
  check("the audit is written", fs.readdirSync(path.join(app, ".talk", "audit")).length > 0);
} catch (err) {
  check("the package test ran", false, err.message);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

console.log(failed === 0 ? "\nThe package test passed." : "\n" + failed + " checks failed.");
process.exitCode = failed === 0 ? 0 : 1;
