import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { run } from "../src/js/clank-talk.js";

// URL patterns in "allow fetch from" and "allow secret ... for fetch to"; see src/md/features/fetch.md

let root;
let server;
let base;
let otherServer;
let otherBase;
let seen;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "clank-fetch-urls-"));
  server = http.createServer((request, response) => {
    seen = { url: request.url, auth: request.headers.authorization || null };
    if (request.url === "/api/to-outside") {
      response.writeHead(302, { Location: "/outside" });
      response.end();
    } else {
      response.end("ok " + request.url);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = "http://127.0.0.1:" + server.address().port;
  otherServer = http.createServer((request, response) => {
    response.end("other");
  });
  await new Promise((resolve) => otherServer.listen(0, "127.0.0.1", resolve));
  otherBase = "http://127.0.0.1:" + otherServer.address().port;
  await fs.writeFile(path.join(root, ".env"), "TOKEN=tok-1234567890\n");
});

after(async () => {
  server.close();
  otherServer.close();
  await fs.rm(root, { recursive: true, force: true });
});

async function agents(...lines) {
  // these tests fetch many times in one session; session taint has its own tests
  await fs.writeFile(path.join(root, "AGENTS.talk"), ["taint off", ...lines].join("\n"));
}

async function firstError(source, options = {}) {
  const result = await run(source, { root, lookup: async () => [], ...options });
  return result.errors.length === 0 ? null : result.errors[0].message;
}

const refused = (host) => "fetch refused: " + host + " is a local or private address.";

test("a URL with a port allows only that port of a private host", async () => {
  await agents(`allow fetch from ${base}/`);
  assert.equal(await firstError(`fetch '${base}/a/b'`), null);
  assert.ok((await firstError(`fetch '${otherBase}/'`)).startsWith(refused("127.0.0.1")));
});

test("a path that ends in / allows the paths below it, on whole parts", async () => {
  await agents(`allow fetch from ${base}/api/`);
  assert.equal(await firstError(`fetch '${base}/api/'`), null);
  assert.equal(await firstError(`fetch '${base}/api/x/y?q=1'`), null);
  assert.ok((await firstError(`fetch '${base}/apix'`)).startsWith(refused("127.0.0.1")));
  assert.ok((await firstError(`fetch '${base}/other'`)).startsWith(refused("127.0.0.1")));
  // the URL parser removes .. before the match
  assert.ok((await firstError(`fetch '${base}/api/../other'`)).startsWith(refused("127.0.0.1")));
});

test("a path with no / at the end allows only that path, and * and ** are globs", async () => {
  await agents(`allow fetch from ${base}/text, ${base}/files/*.json, ${base}/docs/**/index.html`);
  assert.equal(await firstError(`fetch '${base}/text'`), null);
  assert.ok((await firstError(`fetch '${base}/text/more'`)).startsWith(refused("127.0.0.1")));
  assert.equal(await firstError(`fetch '${base}/files/a.json'`), null);
  assert.ok((await firstError(`fetch '${base}/files/a/b.json'`)).startsWith(refused("127.0.0.1")));
  assert.ok((await firstError(`fetch '${base}/files/a.txt'`)).startsWith(refused("127.0.0.1")));
  assert.equal(await firstError(`fetch '${base}/docs/index.html'`), null);
  assert.equal(await firstError(`fetch '${base}/docs/a/b/index.html'`), null);
});

test("the scheme must match, and the path keeps its case", async () => {
  await agents(`allow fetch from https://127.0.0.1:${server.address().port}/, ${base}/API/`);
  assert.ok((await firstError(`fetch '${base}/'`)).startsWith(refused("127.0.0.1")));
  assert.equal(await firstError(`fetch '${base}/API/x'`), null);
  assert.ok((await firstError(`fetch '${base}/api/x'`)).startsWith(refused("127.0.0.1")));
});

test("a redirect must match a URL pattern too", async () => {
  await agents(`allow fetch from ${base}/api/`);
  assert.ok((await firstError(`fetch '${base}/api/to-outside'`)).startsWith(refused("127.0.0.1")));
});

test("in the host, *. is one more part, and a host string still allows all ports", async () => {
  // a public name: the check passes, and then the fetch fails, because .invalid does not resolve
  await agents("allow fetch from http://*.example.invalid/");
  assert.match(await firstError("fetch 'http://api.example.invalid/'"), /^fetch failed/);
  assert.doesNotMatch(await firstError("fetch 'http://a.b.example.invalid/'"), /^fetch failed/);
  assert.doesNotMatch(await firstError("fetch 'http://example.invalid/'"), /^fetch failed/);
  assert.doesNotMatch(await firstError("fetch 'https://api.example.invalid/'"), /^fetch failed/);
  await agents("allow fetch from '127.0.0.1'");
  assert.equal(await firstError(`fetch '${base}/'`), null);
  assert.equal(await firstError(`fetch '${otherBase}/'`), null);
});

test("a secret with a URL pattern goes only to that URL, also after a redirect", async () => {
  await agents("allow fetch from '127.0.0.1'", `allow secret TOKEN for fetch to ${base}/api/`);
  seen = null;
  assert.equal(await firstError(`fetch '${base}/api/x' with headers: { Authorization: secret TOKEN }`), null);
  assert.deepEqual(seen, { url: "/api/x", auth: "tok-1234567890" });
  seen = null;
  assert.equal(await firstError(`fetch '${base}/other' with headers: { Authorization: secret TOKEN }`), `A secret cannot go to ${base}/other: TOKEN. It can go only to ${base}/api/.`);
  assert.equal(seen, null);
  // a redirect on the same origin keeps the headers, so the secret must not go on to /outside
  assert.equal(await firstError(`fetch '${base}/api/to-outside' with headers: { Authorization: secret TOKEN }`), `A secret cannot go to ${base}/outside: TOKEN. It can go only to ${base}/api/.`);
  assert.equal(seen.url, "/api/to-outside");
});

test("a bad URL pattern is a load error", async () => {
  for (const [pattern, message] of [
    ["ftp://example.com/", "A fetch URL must start with http:// or https://, found 'ftp://example.com/'"],
    ["https://example.com/?a=1", "A fetch URL here has no user name, password, ? or #, found 'https://example.com/?a=1'"],
    ["https://api.*.com/", "In the host, * must be the first part, as in https://*.github.com/, found 'https://api.*.com/'"],
    ["https://a*.github.com/", "In the host, * must be the first part, as in https://*.github.com/, found 'https://a*.github.com/'"],
  ]) {
    await agents("allow fetch from " + pattern);
    assert.equal(await firstError("print 1"), message);
  }
});

test("a policy that limits fetch checks the host of a URL pattern", async () => {
  const policy = { name: "acme.talk", source: "policy 'net'\nlimit fetch to 'api.github.com'" };
  await agents("allow fetch from https://api.github.com/repos/");
  assert.equal(await firstError("print 1", { policy }), null);
  await agents("allow fetch from https://evil.example/");
  assert.match(await firstError("print 1", { policy }), /^'allow fetch from https:\/\/evil\.example\/' is outside the policy/);
});
