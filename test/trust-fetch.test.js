import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { run } from "../src/js/clank-talk.js";
import { taintCommand } from "../src/js/taint-cli.js";

// trust fetch from: text from these URLs is not an untrusted input; see src/md/features/taint.md

let server;
let base;
const dirs = [];

before(async () => {
  server = http.createServer((request, response) => {
    if (request.url === "/hop") {
      response.writeHead(302, { Location: "/other" });
      response.end();
      return;
    }
    response.end("text from " + request.url);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = "http://127.0.0.1:" + server.address().port;
});

after(async () => {
  server.close();
  for (const dir of dirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function project(lines) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "clank-trust-"));
  dirs.push(root);
  await fs.writeFile(path.join(root, "AGENTS.talk"), lines + "\n");
  return root;
}

test("a trusted URL does not taint; other paths, and a redirect away, still do", async () => {
  const root = await project("allow fetch from '127.0.0.1'\ntrust fetch from " + base + "/docs/");
  const trusted = await run("fetch " + base + "/docs/a\nprint the session is untrusted", { root });
  assert.deepEqual(trusted.errors, []);
  assert.deepEqual(trusted.output, ["false"]);
  const other = await run("fetch " + base + "/other\nprint the session is untrusted", { root });
  assert.deepEqual(other.output, ["true"]);
});

test("a redirect from a trusted URL to another path is untrusted", async () => {
  const root = await project("allow fetch from '127.0.0.1'\ntrust fetch from " + base + "/hop");
  const result = await run("fetch " + base + "/hop\nprint the session is untrusted", { root });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.output, ["true"]);
});

test("trust fetch from is only in AGENTS.talk, and a policy can deny it", async () => {
  const root = await project("allow fetch from '127.0.0.1'\ntrust fetch from " + base + "/docs/");
  const policy = { name: "p.talk", source: "policy 'p'\ndeny trust" };
  assert.match((await run("print 1", { root, policy })).errors[0].message, /^This trusts fetched text, and .* denies trust/);
  assert.match((await run("print 1", { root: await project("trust fetch 'x'") })).errors[0].message, /^Expected 'fetch from'/);
});

test("a trusted URL is allowed too: no allow line, and no question", async () => {
  const root = await project("trust fetch from " + base + "/docs/");
  const asked = [];
  const ask = async (question) => { asked.push(question); return null; };
  const trusted = await run("fetch " + base + "/docs/a\nprint it", { root, ask });
  assert.deepEqual(trusted.errors, []);
  assert.deepEqual(trusted.output, ["text from /docs/a"]);
  // another path of the same private host is not trusted, so it needs its own allow line
  const other = await run("fetch " + base + "/other", { root, ask });
  assert.match(other.errors[0].message, /is a local or private address/);
  assert.deepEqual(asked, []);
});

test("trust fetch from '*' trusts and allows every public host, with a warning on each run", async () => {
  const root = await project("trust fetch from '*'");
  const asked = [];
  const ask = async (question) => { asked.push(question); return null; };
  // a public name: no question; the fetch then fails only because the name does not resolve
  const result = await run("fetch 'http://api.example.invalid/'", { root, ask, lookup: async () => [] });
  assert.deepEqual(asked, []);
  assert.doesNotMatch(result.errors[0].message, /did not approve|refused/);
  assert.match(result.warnings.map((warning) => warning.message).join("\n"), /trusts text from all public hosts \(trust fetch from '\*'\)/);
});

test("'*' does not cover private hosts, or public names that point to them", async () => {
  const root = await project("trust fetch from '*'\nallow fetch from '*'");
  const local = await run("fetch " + base + "/docs/a", { root });
  assert.match(local.errors[0].message, /is a local or private address/);
  const hidden = await run("fetch 'http://sneaky.example.invalid/'", { root, lookup: async () => ["10.0.0.1"] });
  assert.match(hidden.errors[0].message, /points to a local or private address/);
  assert.match(local.warnings.map((warning) => warning.message).join("\n"), /allows fetch from all public hosts/);
});

test("a secret cannot go to '*'", async () => {
  const root = await project("allow secret TOKEN for fetch to '*'");
  assert.match((await run("print 1", { root })).errors[0].message, /cannot send a secret to every host/);
});

test("the taint command shows the '*' warning", async () => {
  const root = await project("trust fetch from '*'");
  const lines = [];
  await taintCommand([], root, (line) => lines.push(line));
  assert.match(lines.join("\n"), /^warning: AGENTS.talk trusts text from all public hosts/m);
});