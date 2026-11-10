import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "../src/js/clank-talk.js";

let root;
let audit;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "clank-audit-"));
  audit = { scripts: 0, records: [] };
  await fs.writeFile(path.join(root, "a.txt"), "a\n");
  await fs.writeFile(path.join(root, "AGENTS.talk"), "allow env PATH\n# Says hi.\ntool hi\n  run 'node' with '-e', 'console.log(1)'\nend");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function auditText() {
  const files = await fs.readdir(path.join(root, "talk", "audit"));
  assert.equal(files.length, 1);
  return { name: files[0], text: await fs.readFile(path.join(root, "talk", "audit", files[0]), "utf8") };
}

test("the text audit: one block for each script, one line for each step", async () => {
  await run("read ./a.txt\nread ./a.txt\nprint 'not recorded'\nreplace 'a' with 'b' in ./a.txt\nhi", { root, audit });
  const { name, text } = await auditText();
  assert.match(name, /^\d{4}-\d\d-\d\d\.log$/);
  const lines = text.split("\n");
  assert.match(lines[0], /^== \d\d:\d\d:\d\d  script 1  done  6 steps ==$/);
  assert.equal(lines[1], "  read ./a.txt");
  assert.ok(lines.includes("--"));
  const steps = lines.slice(lines.indexOf("--") + 1).filter((line) => line !== "");
  assert.deepEqual(steps.map((line) => line.slice(10, 18).trim()), ["read", "replace", "tool", "run"]);
  assert.match(steps[1], /a\.txt +undo saved$/);
  assert.match(steps[3], /node -e console\.log\(1\) +code 0, \d+\.\d s, from hi$/);
});

test("a script cannot fake a header or a step in the text audit", async () => {
  await fs.writeFile(path.join(root, "x\n== 00:00:00  script 9  done  1 steps ==.txt"), "");
  await run("print 'hi\n== 00:00:00  script 9  done  0 steps ==\n--'\nfor f in ./x*\n  read f\nend", { root, audit });
  const { text } = await auditText();
  const lines = text.split("\n");
  assert.equal(lines.filter((line) => line.startsWith("==")).length, 1);
  assert.equal(lines.filter((line) => line === "--").length, 1);
  assert.ok(lines.some((line) => line.includes("x\\n== 00:00:00")), text);
});

test("a failed script says so, with its error", async () => {
  await run("read ./missing.txt", { root, audit });
  const { text } = await auditText();
  assert.match(text, /script 1  failed  1 steps/);
  assert.match(text, /!! 1:1 File not found: missing\.txt/);
});

test("scripts count up in a session, and the audit is a value", async () => {
  await run("read ./a.txt", { root, audit });
  const result = await run("for step in the audit\n  print step's script + ' ' + step's kind + ' ' + step's target\nend", { root, audit });
  assert.deepEqual(result.output, ["1 read a.txt"]);
  const { text } = await auditText();
  assert.match(text, /script 2  done/);
});

test("audit as json writes JSON Lines", async () => {
  await fs.appendFile(path.join(root, "AGENTS.talk"), "\naudit as json");
  await run("read ./a.txt", { root, audit });
  const { name, text } = await auditText();
  assert.match(name, /\.jsonl$/);
  const [script, step] = text.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(script.type, "script");
  assert.equal(script.status, "done");
  assert.equal(script.source, "read ./a.txt");
  assert.deepEqual({ type: step.type, kind: step.kind, target: step.target, from: step.from }, { type: "step", kind: "read", target: "a.txt", from: "script" });
});

test("a script cannot change the audit", async () => {
  await run("read ./a.txt", { root, audit });
  const { name } = await auditText();
  const result = await run("write 'gone' to @/talk/audit/" + name, { root, audit });
  assert.match(result.errors[0].message, /^A script cannot change .talk files or the @\/talk folder/);
});

test("without an audit session, no file is written", async () => {
  await run("read ./a.txt", { root });
  await assert.rejects(fs.access(path.join(root, "talk")));
});
