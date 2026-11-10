import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { run } from "../src/js/clank-talk.js";

let root;
let server;
let base;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "clank-fetch-"));
  server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      if (request.url === "/text") {
        response.end("hello");
      } else if (request.url === "/json") {
        response.setHeader("Content-Type", "application/json");
        response.end('{"a": 1}');
      } else if (request.url === "/echo") {
        response.end(JSON.stringify({ method: request.method, type: request.headers["content-type"], key: request.headers["x-key"], body }));
      } else if (request.url === "/to-localhost") {
        response.writeHead(302, { Location: "http://localhost:" + server.address().port + "/text" });
        response.end();
      } else if (request.url === "/to-text") {
        response.writeHead(302, { Location: "/text" });
        response.end();
      } else if (request.url === "/big") {
        response.end("x".repeat(6 * 1024 * 1024));
      } else {
        response.statusCode = 404;
        response.end("not here");
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = "http://127.0.0.1:" + server.address().port;
  await fs.writeFile(path.join(root, "AGENTS.talk"), "allow fetch from '127.0.0.1'");
});

after(async () => {
  server.close();
  await fs.rm(root, { recursive: true, force: true });
});

async function output(source, options = {}) {
  const result = await run(source, { root, ...options });
  assert.deepEqual(result.errors, []);
  return result.output;
}

async function errors(source, options = {}) {
  const result = await run(source, { root, ...options });
  return result.errors.map((e) => e.message);
}

test("fetch text, json and a response", async () => {
  assert.deepEqual(await output(`fetch '${base}/text'\nprint it`), ["hello"]);
  assert.deepEqual(await output(`fetch '${base}/json' as json\nprint it's a`), ["1"]);
  assert.deepEqual(await output(`fetch '${base}/nope' as response\nprint it's status\nprint it's text`), ["404", "not here"]);
});

test("a status of 400 or more is an error, without as response", async () => {
  assert.deepEqual(await errors(`fetch '${base}/nope'`), [`fetch got status 404 from ${base}/nope: 'not here'`]);
});

test("method, headers and a JSON body", async () => {
  const [line] = await output(`fetch '${base}/echo' as json with method: 'post', headers: { 'X-Key': 7 }, body: { a: 1 }\nprint it as json`);
  assert.deepEqual(JSON.parse(line), { method: "POST", type: "application/json", key: "7", body: '{"a":1}' });
  assert.deepEqual(await errors(`fetch '${base}/text' with color: 'red'`), ["fetch takes method, headers and body, not 'color'"]);
});

test("a redirect is followed only to an allowed host", async () => {
  assert.deepEqual(await output(`fetch '${base}/to-text'\nprint it`), ["hello"]);
  const [message] = await errors(`fetch '${base}/to-localhost'`);
  assert.equal(message, "fetch refused: localhost is a local or private address.\nTo allow it, a human can add this line to AGENTS.talk:\n  allow fetch from 'localhost'");
});

test("a new public host asks the human, once per session", async () => {
  const fetchHosts = new Set();
  const asked = [];
  const no = async (request) => {
    asked.push(request.question);
    return "no";
  };
  assert.match((await errors("fetch 'https://example.invalid/'", { ask: no, fetchHosts }))[0], /^The human did not approve a fetch from example.invalid\./);
  assert.match((await errors("fetch 'https://example.invalid/'"))[0], /there is no way to ask them here/);
  const yes = async (request) => {
    asked.push(request.question);
    return "yes";
  };
  // the human says yes; the host does not exist, so the fetch itself fails
  assert.match((await errors("fetch 'https://example.invalid/'", { ask: yes, fetchHosts }))[0], /^fetch failed: /);
  assert.match((await errors("fetch 'https://example.invalid/'", { ask: yes, fetchHosts }))[0], /^fetch failed: /);
  assert.deepEqual(asked, ["Fetch from example.invalid?", "Fetch from example.invalid?"]);
});

test("limits", async () => {
  assert.deepEqual(await errors(`fetch '${base}/big'`), [`fetch got more than 5242880 bytes from ${base}/big`]);
  assert.deepEqual(await errors("fetch 'file:///etc/passwd'"), ["fetch only takes http and https URLs, found 'file:///etc/passwd'"]);
  assert.deepEqual(await errors("fetch 'nope'"), ["Not a valid URL: 'nope'"]);
  assert.deepEqual(await errors("fetch 'http://10.0.0.1/'"), ["fetch refused: 10.0.0.1 is a local or private address.\nTo allow it, a human can add this line to AGENTS.talk:\n  allow fetch from '10.0.0.1'"]);
});

test("private hosts in every form are refused, and a *. pattern does not allow them", async () => {
  await fs.writeFile(path.join(root, "AGENTS.talk"), "allow fetch from '*.localhost'");
  const hosts = {
    "http://localhost./": "localhost",
    "http://a.localhost/": "a.localhost",
    "http://[::127.0.0.1]/": "[::7f00:1]",
    "http://[::ffff:127.0.0.1]/": "[::ffff:7f00:1]",
    "http://[64:ff9b::7f00:1]/": "[64:ff9b::7f00:1]",
    "http://[2002:7f00:1::]/": "[2002:7f00:1::]",
    "http://[fe90::1]/": "[fe90::1]",
    "http://[fec0::1]/": "[fec0::1]",
    "http://192.0.0.192/": "192.0.0.192",
    "http://198.18.0.1/": "198.18.0.1",
    "http://224.0.0.1/": "224.0.0.1",
    "http://0x7f.1/": "127.0.0.1",
  };
  for (const [url, host] of Object.entries(hosts)) {
    assert.match((await errors(`fetch '${url}'`))[0], new RegExp("^fetch refused: " + host.replace(/[.[\]]/g, "\\$&") + " is a local or private address"), url);
  }
  await fs.rm(path.join(root, "AGENTS.talk"));
});

test("hooks can watch and reject fetch", async () => {
  await fs.writeFile(path.join(root, "AGENTS.talk"), "allow fetch from '127.0.0.1'\nbefore fetch\n  if the fetch's method is 'POST'\n    reject 'no posts'\n  end\nend");
  try {
    assert.deepEqual(await errors(`fetch '${base}/echo' with method: 'POST'`), ["no posts"]);
    assert.deepEqual(await output(`fetch '${base}/text'\nprint it`), ["hello"]);
  } finally {
    await fs.writeFile(path.join(root, "AGENTS.talk"), "allow fetch from '127.0.0.1'");
  }
});

test("wait until, with fetch as a value", async () => {
  assert.deepEqual(await output(`wait until (fetch '${base}/text' as response)'s status is 200 within 2 seconds\nprint 'up'`), ["up"]);
  const [message] = await errors(`wait until (fetch 'http://127.0.0.1:1/' as response)'s status is 200 within 500ms`);
  assert.match(message, /^wait until did not come true within 500ms\. The last error: fetch failed: /);
  assert.deepEqual(await errors("wait until false within 300ms"), ["wait until did not come true within 300ms"]);
  assert.deepEqual(await output(`set page to fetch '${base}/text'\nprint page`), ["hello"]);
});
