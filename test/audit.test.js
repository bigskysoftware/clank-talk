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
  const files = await fs.readdir(path.join(root, ".talk", "audit"));
  assert.equal(files.length, 1);
  return { name: files[0], text: await fs.readFile(path.join(root, ".talk", "audit", files[0]), "utf8") };
}

test("the text audit: one block for each script, one line for each step", async () => {
  await run("read ./a.txt\nread ./a.txt\nprint 'not recorded'\nreplace 'a' with 'b' in ./a.txt\nhi", { root, audit });
  const { name, text } = await auditText();
  assert.match(name, /^\d{4}-\d\d-\d\d\.log$/);
  const lines = text.split("\n");
  assert.match(lines[0], /^== \d\d:\d\d:\d\d  script 1  \(done, 6 steps\) ==$/);
  assert.equal(lines[1], "  read ./a.txt");
  assert.ok(lines.includes("--"));
  const steps = lines.slice(lines.indexOf("--") + 1).filter((line) => line !== "");
  assert.deepEqual(steps.map((line) => line.slice(10, 18).trim()), ["read", "replace", "tool", "run"]);
  assert.match(steps[1], /a\.txt +1 match, line 1$/);
  // the program is indented under its tool
  assert.match(steps[3], /^\d\d:\d\d:\d\d    run    node -e console\.log\(1\) +no sandbox, code 0, \d+\.\d s$/);
});

test("each edit says what it did", async () => {
  const script = [
    "write 'one\ntwo\nthree\n' to ./b.txt",
    "append 'four\n' to ./b.txt",
    "put 'new\n' after line 1 of ./b.txt",
    "replace lines 2 to 3 of ./b.txt with 'x\ny\nz\n'",
    "remove lines 1 to 2 of ./b.txt",
    "replace 'z' with 'Z' in ./b.txt",
    "replace 'nothing here' with 'x' in ./b.txt",
  ].join("\n");
  assert.deepEqual((await run(script, { root, audit })).errors, []);
  const details = audit.records.map((record) => record.kind + ": " + record.details);
  assert.deepEqual(details.filter((line) => !line.startsWith("read")), [
    "write: 3 lines, new file",
    "append: 1 line at the end",
    "put: 1 line after line 1",
    "replace: lines 2-3 with 3 lines",
    "remove: lines 1-2",
    "replace: 1 match, line 2",
    "replace: no match",
  ]);
});

test("a git step shows what the script wrote, and the JSON audit keeps the full arguments", async () => {
  const { execFileSync } = await import("node:child_process");
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH, HOME: root } });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  assert.deepEqual((await run("git commit [./a.txt] with 'Add a'\ngit status\ngit switch to new branch 'fix-x'", { root, audit })).errors, []);
  const steps = audit.records.filter((record) => record.kind === "git").map((record) => [record.target, record.details]);
  assert.deepEqual(steps, [["commit 'Add a'", "1 file"], ["status", ""], ["switch to new branch fix-x", ""]]);
  assert.match(audit.records.find((record) => record.kind === "git").args, /^commit --no-verify /);
});

test("a pattern that is not valid gives a hint for the common causes", async () => {
  const message = async (script) => (await run(script, { root })).errors[0].message;
  assert.match(await message("find pattern '(?i)x' in 'abc'"), /Invalid group\.\nJavaScript has no \(\?i\)/);
  assert.match(await message("find pattern \"\"\"a\\-b\"\"\" in 'abc'"), /Invalid escape\.\nWith the u flag/);
  assert.match(await message("find pattern 'test\\(' in 'abc'"), /\nIn a quoted string, a backslash is an escape of the string/);
});

test("found null in an error says what null means", async () => {
  assert.equal((await run("set hits to null\nfind 'x' in hits", { root })).errors[0].message, "'find' needs a file, a list of files, lines, or text, found null: the value has nothing in it.\nIf it came from an earlier find or fetch, that command found nothing.");
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
  assert.match(text, /script 1  \(failed, 1 step\)/);
  assert.match(text, /!! 1:1 File not found: missing\.txt/);
});

test("scripts count up in a session, and the audit is a value", async () => {
  await run("read ./a.txt", { root, audit });
  const result = await run("for step in the audit\n  print step's script + ' ' + step's kind + ' ' + step's target\nend", { root, audit });
  assert.deepEqual(result.output, ["1 read a.txt"]);
  const { text } = await auditText();
  assert.match(text, /script 2  \(done, /);
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
  const result = await run("write 'gone' to @/.talk/audit/" + name, { root, audit });
  assert.match(result.errors[0].message, /^A script cannot change .talk files or the @\/talk folder/);
});

test("without an audit session, no file is written", async () => {
  await run("read ./a.txt", { root });
  await assert.rejects(fs.access(path.join(root, "talk")));
});

test("a session line comes before the first script of a session; the header names an agent, and the purpose", async () => {
  await run("print 1", { root, audit, session: "claude-code-4f2a" });
  await run("print 2", { root, audit, session: "claude-code-4f2a", agent: "tester" });
  const { text } = await auditText();
  assert.equal(text.match(/^-- session claude-code-4f2a --$/gm).length, 1);
  assert.match(text, /^== \d\d:\d\d:\d\d  script 1  \(done, 1 step\) ==$/m);
  assert.match(text, /^== \d\d:\d\d:\d\d  script 2 \(tester\)  \(done, 1 step\) ==$/m);
  // a first line "# ..." is the purpose: in the header, and not again in the script
  await run("# Fix the cart total\nprint 3", { root, audit, session: "claude-code-4f2a" });
  const after = (await auditText()).text;
  assert.match(after, /^== \d\d:\d\d:\d\d  script 3  Fix the cart total  \(done, 1 step\) ==\n  print 3\n--$/m);
});


// ----- rotation and .talk/ -----

function dayBefore(days) {
  const now = new Date();
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
}

test("the audit keeps 3 days by default, and deletes only older day files", async () => {
  const folder = path.join(root, ".talk", "audit");
  await fs.mkdir(folder, { recursive: true });
  for (const name of [dayBefore(2) + ".log", dayBefore(3) + ".log", dayBefore(9) + ".jsonl", "notes.txt"]) {
    await fs.writeFile(path.join(folder, name), "old\n");
  }
  await run("print 1", { root, audit });
  const left = (await fs.readdir(folder)).sort();
  assert.ok(left.includes(dayBefore(2) + ".log"));
  assert.ok(!left.includes(dayBefore(3) + ".log"));
  assert.ok(!left.includes(dayBefore(9) + ".jsonl"));
  assert.ok(left.includes("notes.txt"));
  const step = audit.records.find((record) => record.kind === "audit");
  assert.equal(step.details, "deleted 2 files older than 3 days");
});

test("keep audit for <n> days, and a policy minimum", async () => {
  const folder = path.join(root, ".talk", "audit");
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, dayBefore(5) + ".log"), "old\n");
  await fs.writeFile(path.join(root, "AGENTS.talk"), "keep audit for 7 days");
  await run("print 1", { root, audit });
  assert.ok((await fs.readdir(folder)).includes(dayBefore(5) + ".log"));
  const policy = { name: "p.talk", source: "policy 'p'\nkeep audit for at least 30 days" };
  const result = await run("print 1", { root, policy });
  assert.deepEqual(result.errors.map((e) => e.message), ["'keep audit for 7 days' is fewer than the policy: p.talk 2:1 keeps the audit for at least 30 days"]);
  await fs.writeFile(path.join(root, "AGENTS.talk"), "keep audit for at least 7 days");
  assert.match((await run("print 1", { root })).errors[0].message, /'at least' is only for a policy/);
});

test("no allow line opens .talk/, and globs skip it", async () => {
  await fs.writeFile(path.join(root, "AGENTS.talk"), "allow changes to @/.talk/");
  assert.deepEqual((await run("print 1", { root })).errors.map((e) => e.message), ["Cannot allow changes to @/.talk/: .talk/ and talk/ hold the audit and the tools, and no line can open them"]);
  await fs.writeFile(path.join(root, "AGENTS.talk"), "");
  await run("print 1", { root, audit });
  const result = await run("print @/**/*.log", { root });
  assert.deepEqual(result.output, ["[]"]);
});

