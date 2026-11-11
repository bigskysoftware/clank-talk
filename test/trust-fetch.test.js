import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { run } from "../src/js/clank-talk.js";

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
