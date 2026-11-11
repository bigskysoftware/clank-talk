import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { run } from "../src/js/clank-talk.js";
import { taintCommand } from "../src/js/taint-cli.js";

// npx clank-talk taint; see src/md/features/taint.md

const dirs = [];

after(async () => {
  for (const dir of dirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function project(line = "") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clank-taint-cli-"));
  dirs.push(dir);
  await fs.writeFile(path.join(dir, "AGENTS.talk"), line + "\nuntrusted tool issue with id\n  set the result to 'issue ' + id\nend\n");
  return dir;
}

async function taint(root, ...args) {
  const lines = [];
  const code = await taintCommand(args, root, (line) => lines.push(line));
  return { code, text: lines.join("\n") };
}

async function untrustedNow(root, session) {
  return (await run("print the session is untrusted", { root, session })).output[0] === "true";
}

test("the list shows the state, and each input with its ref, status, size and source", async () => {
  const root = await project();
  assert.equal((await taint(root)).text, "taint: on (the default)\nNo untrusted inputs.");
  await run("issue 1\nissue 2", { root, session: "s-1" });
  const { code, text } = await taint(root);
  assert.equal(code, 0);
  const lines = text.split("\n");
  assert.equal(lines[0], "taint: on (the default)");
  assert.match(lines[2], /^ref +time +status +size +judge +source$/);
  assert.match(lines[3], /^s-1\/1 +\d{4}-\d\d-\d\d \d\d:\d\d:\d\d +new +7 B +- +tool issue \(1\)$/);
  assert.match(lines[4], /^s-1\/2 /);
  assert.equal(lines[6], "2 not approved. Show one with: npx clank-talk taint show <ref>");
});

test("show prints one input; a bare number is in the newest session", async () => {
  const root = await project();
  await run("issue 1", { root, session: "s-1" });
  await run("issue 9", { root, session: "s-2" });
  const { text } = await taint(root, "show", "1");
  assert.match(text, /^status: new\njudge: -\nsource: tool issue \(9\)\ntime: .+\n\nissue 9$/);
  assert.match((await taint(root, "show", "s-1/1")).text, /issue 1$/);
  assert.deepEqual(await taint(root, "show", "s-1/7"), { code: 1, text: "No untrusted input s-1/7. List them with: npx clank-talk taint" });
});

test("approve clears the inputs that it names, and --all clears all", async () => {
  const root = await project();
  await run("issue 1\nissue 2", { root, session: "s-1" });
  await run("issue 3", { root, session: "s-2" });
  assert.deepEqual(await taint(root, "approve", "s-1/1"), { code: 0, text: "Approved 1 input." });
  assert.equal(await untrustedNow(root, "s-1"), true);
  assert.deepEqual(await taint(root, "approve", "s-1/2"), { code: 0, text: "Approved 1 input." });
  // taint is for the whole project: s-2 still has an input that is not approved
  assert.equal(await untrustedNow(root, "s-1"), true);
  assert.equal(await untrustedNow(root, "s-2"), true);
  assert.deepEqual(await taint(root, "approve", "--all"), { code: 0, text: "Approved 1 input." });
  assert.equal(await untrustedNow(root, "s-2"), false);
  assert.match((await taint(root, "show", "s-2/1")).text, /^status: approved by the command line\n/);
  // a bad ref approves nothing
  assert.deepEqual(await taint(root, "approve", "s-9/1"), { code: 1, text: "No untrusted input s-9/1. Nothing was approved." });
  // --clean approves only inputs that the judge found clean; there is no judge yet
  await run("issue 4", { root, session: "s-3" });
  assert.deepEqual(await taint(root, "approve", "--clean"), { code: 0, text: "Approved 0 inputs." });
});

test("on and off win over AGENTS.talk, but not over taint required", async () => {
  const root = await project("taint off");
  assert.match((await taint(root)).text, /^taint: off \(from AGENTS\.talk\)/);
  assert.deepEqual(await taint(root, "on"), { code: 0, text: "taint: on (from the command line)" });
  await run("issue 1", { root, session: "s-1" });
  assert.equal(await untrustedNow(root, "s-1"), true);
  const required = await project("taint required");
  assert.deepEqual(await taint(required, "off"), { code: 1, text: "AGENTS.talk has 'taint required'. To turn taint off, remove that line." });
  assert.match((await taint(required)).text, /^taint: on \(required by AGENTS\.talk\)/);
});

test("list and show replace control characters from untrusted text", async () => {
  const root = await project();
  await run("issue '\u001b[2Kclean\u0007'", { root, session: "s-1" });
  const list = (await taint(root)).text;
  const show = (await taint(root, "show", "1")).text;
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(list + show));
  assert.match(list, /tool issue \(\?\[2Kclean\?\)/);
  assert.match(show, /\n\nissue \?\[2Kclean\?$/);
});

test("review 12: the command line knows about require taint in a policy", async () => {
  const root = await project();
  const policy = { name: "acme.talk", source: "policy 'safe'\nrequire taint" };
  await run("print 1", { root, policy });
  assert.match((await taint(root)).text, /^taint: on \(required by the policy safe\)/);
  assert.deepEqual(await taint(root, "off"), { code: 1, text: "The policy safe has 'require taint', so taint stays on." });
  // a run with a policy that does not require it removes the note
  await run("print 1", { root, policy: { name: "other.talk", source: "policy 'other'\nlimit fetch to 'example.com'" } });
  assert.match((await taint(root)).text, /^taint: on \(the default\)/);
});

test("an unknown command shows the usage", async () => {
  const root = await project();
  const { code, text } = await taint(root, "clear");
  assert.equal(code, 1);
  assert.match(text, /^Unknown taint command: clear\n\nUsage: clank-talk taint/);
});

test("the bin runs, with --root", async () => {
  const root = await project();
  const bin = path.join(import.meta.dirname, "..", "bin", "clank-talk.js");
  assert.equal(execFileSync(process.execPath, [bin, "taint", "--root", root], { encoding: "utf8" }), "taint: on (the default)\nNo untrusted inputs.\n");
});
