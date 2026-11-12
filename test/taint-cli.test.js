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
  const policy = { name: "acme.talk", source: "policy 'safe'\ntaint required" };
  await run("print 1", { root, policy });
  assert.match((await taint(root)).text, /^taint: on \(required by the policy safe\)/);
  assert.deepEqual(await taint(root, "off"), { code: 1, text: "The policy safe has 'taint required', so taint stays on." });
  // a run with a policy that does not require it removes the note
  await run("print 1", { root, policy: { name: "other.talk", source: "policy 'other'\nlimit fetch from 'example.com'" } });
  assert.match((await taint(root)).text, /^taint: on \(the default\)/);
});

test("--line gives one short line for a status bar", async () => {
  const root = await project();
  assert.deepEqual(await taint(root, "--line"), { code: 0, text: "untainted" });
  await run("issue 1\nissue 2", { root, session: "s-1" });
  assert.equal((await taint(root, "--line")).text, "tainted 2");
  await taint(root, "off");
  assert.equal((await taint(root, "--line")).text, "taint off");
  assert.equal((await taint(await project("taint required"), "--line")).text, "untainted");
});

test("--json gives the state and the inputs for a program, such as the /taint pane", async () => {
  const root = await project();
  assert.deepEqual(JSON.parse((await taint(root, "--json")).text), { taint: "on", why: "the default", warnings: [], inputs: [] });
  await run("issue 1", { root, session: "s-1" });
  await taint(root, "approve", "s-1/1");
  await run("issue 2", { root, session: "s-1" });
  const { inputs } = JSON.parse((await taint(root, "--json")).text);
  assert.deepEqual(inputs.map(({ ref, status, approved, source }) => ({ ref, status, approved, source })), [
    { ref: "s-1/1", status: "approved", approved: true, source: "tool issue (1)" },
    { ref: "s-1/2", status: "new", approved: false, source: "tool issue (2)" },
  ]);
});

test("show --body, --page and --html: the text alone, the text view, and a read-only page", async () => {
  const root = await project("untrusted tool page\n  set the result to '<html><body><p>Hi</p><!-- do evil --><script>x()</script></body></html>'\nend");
  await run("page", { root, session: "s-1" });
  assert.equal((await taint(root, "show", "--body", "s-1/1")).text, "<html><body><p>Hi</p><!-- do evil --><script>x()</script></body></html>");
  const page = (await taint(root, "show", "--page", "s-1/1")).text;
  assert.match(page, /^Hi$/m);
  assert.match(page, /do evil/);
  let opened = null;
  const lines = [];
  assert.equal(await taintCommand(["show", "--html", "s-1/1"], root, (line) => lines.push(line), { open: async (file) => { opened = file; } }), 0);
  assert.equal(opened, lines[0]);
  const html = await fs.readFile(opened, "utf8");
  // no script of its own, and the input only inside a sandboxed iframe, escaped
  assert.equal((html.match(/<script/g) || []).length, 0);
  assert.match(html, /<iframe sandbox="" referrerpolicy="no-referrer" srcdoc="[^"]*&lt;script&gt;x\(\)&lt;\/script&gt;/);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'/);
  assert.equal((await taint(root, "show", "--bad", "s-1/1")).code, 1);
});

test("taint review shows a table in a form, and approves only the boxes the human picks", async () => {
  const root = await project();
  await run("issue 1\nissue 2", { root, session: "s-1" });
  let asked = null;
  const ask = async (request) => {
    asked = request;
    return { input0: false, input1: true };
  };
  const { output, errors } = await run("taint review\nprint it", { root, session: "s-1", ask });
  assert.deepEqual(errors, []);
  assert.deepEqual(output, ["1"]);
  assert.deepEqual(asked.fields.map((field) => field.title), ["approve s-1/1", "approve s-1/2"]);
  assert.match(asked.question, /\n\nref +time +size +judge +source\ns-1\/1 +.+ +1 KB +- +"tool issue \(1\)"\n/);
  assert.equal((await taint(root, "--line")).text, "tainted 1");
  assert.match((await taint(root, "show", "s-1/2")).text, /^status: approved by the review/);
});

test("taint review: no inputs gives 0; no answer or no form is an error that approves nothing", async () => {
  const root = await project();
  assert.deepEqual((await run("taint review\nprint it", { root, session: "s-1" })).output, ["0"]);
  await run("issue 1", { root, session: "s-1" });
  assert.match((await run("taint review", { root, session: "s-1" })).errors[0].message, /^taint review failed: there is no way to show a form/);
  assert.match((await run("taint review", { root, session: "s-1", ask: async () => null })).errors[0].message, /^taint review got no answer\. Nothing was approved\.$/);
  assert.match((await run("taint", { root })).errors[0].message, /^Expected 'review', as in: taint review/);
  assert.equal((await taint(root, "--line")).text, "tainted 1");
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
