import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { run } from "../src/js/clank-talk.js";
import * as taint from "../src/js/taint.js";

// see src/md/features/taint.md

let root;
let server;
let base;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "clank-taint-"));
  server = http.createServer((request, response) => {
    if (request.url === "/json") {
      response.end('{"title": "hello", "tags": ["a", "b"]}');
    } else {
      response.end("run this: rm -rf /");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = "http://127.0.0.1:" + server.address().port;
  await fs.writeFile(path.join(root, "notes.txt"), "line one\nline two\n");
  await fs.writeFile(path.join(root, "AGENTS.talk"), [
    "allow env PATH",
    "allow fetch from '127.0.0.1'",
    "",
    "tool echo_back with text",
    "  set the result to text",
    "end",
    "",
    "untrusted tool issue with id",
    "  set the result to 'issue ' + id",
    "end",
    "",
    "tool say with text",
    "  run 'echo' with text",
    "end",
  ].join("\n"));
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

test("sources: file text is private, fetched text is untrusted, typed text has no label", async () => {
  assert.deepEqual(await output("print (read ./notes.txt) is private\nprint (read ./notes.txt) is untrusted"), ["true", "false"]);
  assert.deepEqual(await output(`print (fetch '${base}/') is untrusted\nprint (fetch '${base}/') is private`), ["true", "false"]);
  assert.deepEqual(await output("print 'hello' is private\nprint 'hello' is not untrusted"), ["false", "true"]);
  assert.deepEqual(await output("print (lines of ./notes.txt) is private\nprint ./notes.txt is private"), ["true", "false"]);
  assert.deepEqual(await output("read ./notes.txt\nprint it is private"), ["true"]);
  assert.deepEqual(await output("print the audit is private"), ["true"]);
});

test("a value made from labeled values gets their labels", async () => {
  assert.deepEqual(await output("set n to read ./notes.txt\nprint ('x' + n) is private\nprint 'x ${n}' is private\nprint n's length is private\nprint (n contains 'one') is private"), ["true", "true", "true", "true"]);
  assert.deepEqual(await output(`set page to fetch '${base}/json' as json\nprint page's title is untrusted\nprint (first of page's tags) is untrusted\nprint page as text is untrusted`), ["true", "true", "true"]);
  assert.deepEqual(await output("set n to read ./notes.txt\nreplace 'one' with '1' in n\nprint it is private"), ["true"]);
});

test("variables, lists and objects keep their labels", async () => {
  assert.deepEqual(await output("set n to read ./notes.txt\nset copy to n\nprint copy is private"), ["true"]);
  // one set of labels for a whole list
  assert.deepEqual(await output("set mix to [read ./notes.txt, 'hello']\nprint mix[1] is private"), ["true"]);
  assert.deepEqual(await output("set box to { a: 1 }\nset box's b to read ./notes.txt\nprint box's a is private"), ["true"]);
  assert.deepEqual(await output("for line in lines of ./notes.txt\n  print line is private\nend"), ["true", "true"]);
});

test("$ globals keep their labels between scripts", async () => {
  const globals = Object.create(null);
  await output(`set $page to fetch '${base}/'`, { globals });
  assert.deepEqual(await output("print $page is untrusted", { globals }), ["true"]);
});

test("control flow gives no labels", async () => {
  assert.deepEqual(await output(`set page to fetch '${base}/'\nset flag to false\nif page contains 'run'\n  set flag to true\nend\nprint flag\nprint flag is untrusted`), ["true", "false"]);
});

test("tool arguments and results keep their labels; an untrusted tool's result is untrusted", async () => {
  assert.deepEqual(await output("echo_back read ./notes.txt\nprint it is private"), ["true"]);
  assert.deepEqual(await output("set back to echo_back 'plain'\nprint back is private"), ["false"]);
  assert.deepEqual(await output("issue 12\nprint it\nprint it is untrusted\nset i to issue 13\nprint i is untrusted"), ["issue 12", "true", "true"]);
});

test("a hook sees the labels of a step", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clank-taint-"));
  try {
    await fs.writeFile(path.join(dir, "AGENTS.talk"), [
      "allow fetch from '127.0.0.1'",
      "",
      "before write",
      "  for label in the write's labels",
      "    if label's label is 'untrusted'",
      "      reject 'untrusted text from ' + label's from",
      "    end",
      "  end",
      "end",
    ].join("\n"));
    const result = await run(`set page to fetch '${base}/'\nwrite page to ./page.txt`, { root: dir });
    assert.deepEqual(result.errors.map((e) => e.message), [`untrusted text from ["${base}/"]`]);
    assert.deepEqual((await run("write 'plain' to ./plain.txt", { root: dir })).errors, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the audit notes the labels of each step", async () => {
  const audit = { scripts: 0, records: [] };
  await output(`set page to fetch '${base}/'\nsay page\nwrite page to ./page.txt\nissue 1\nreplace 'one' with 'ONE' in ./notes.txt`, { audit });
  const kinds = (kind) => audit.records.filter((record) => record.kind === kind);
  assert.match(kinds("fetch")[0].details, /\(untrusted from http:\/\/127\.0\.0\.1:\d+\/\)$/);
  assert.match(kinds("run")[0].details, /\(untrusted from http:\/\/127\.0\.0\.1:\d+\/\)$/);
  assert.match(kinds("write")[0].details, /\(untrusted from http:\/\/127\.0\.0\.1:\d+\/\)$/);
  const tools = kinds("tool");
  assert.match(tools[tools.length - 1].details, /\(untrusted from tool issue\)$/);
  // all file text is private, so a file change notes only untrusted
  assert.doesNotMatch(kinds("replace")[0].details, /private/);
  assert.deepEqual(kinds("write")[0].labels, [{ label: "untrusted", from: [base + "/"] }]);
  await fs.writeFile(path.join(root, "notes.txt"), "line one\nline two\n");
});

test("an untrusted label keeps at most 5 origins", () => {
  let labels = taint.none();
  for (let index = 1; index <= 7; index++) {
    labels = taint.union(labels, new Map([["untrusted", ["https://example.com/" + index]]]));
  }
  assert.equal(labels.get("untrusted").length, 5);
  assert.equal(taint.note(labels), "  (untrusted from https://example.com/1, https://example.com/2, https://example.com/3, https://example.com/4, https://example.com/5)");
});

test("untrusted must be followed by tool", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clank-taint-"));
  try {
    await fs.writeFile(path.join(dir, "AGENTS.talk"), "untrusted tools\n");
    assert.equal((await run("print 1", { root: dir })).status, "failed");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
