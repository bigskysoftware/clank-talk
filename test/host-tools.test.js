import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "../src/js/clank-talk.js";
import { describeTool } from "../src/js/host.js";

// host tools with a description, params, untrusted and effects; see src/md/infrastructure/host.md

const dirs = [];

after(async () => {
  for (const dir of dirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function project(agentsTalk = "") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "clank-host-tools-"));
  dirs.push(root);
  await fs.writeFile(path.join(root, "AGENTS.talk"), agentsTalk + "\n");
  return root;
}

test("a plain function is still a host tool, and an object needs a run function", async () => {
  const root = await project();
  assert.deepEqual((await run("print hello", { root, tools: { hello: async () => "hi" } })).output, ["hi"]);
  assert.deepEqual((await run("print 1", { root, tools: { broken: {} } })).errors.map((e) => e.message), ["The host tool broken has no run function"]);
});

test("help tools, the tool description and hooks see a host tool's description and params", async () => {
  const root = await project("before excel_read\n  reject 'no to ' + the excel_read's path\nend");
  const tools = { excel_read: { description: "Reads a workbook.", params: ["path"], run: async () => "rows" } };
  const help = await run("help tools", { root, tools });
  assert.match(help.output[0], /excel_read with path/);
  assert.match(help.output[0], /Reads a workbook\./);
  assert.match(await describeTool(root, tools), /Tools from AGENTS.talk and the host[^\n]*\n  excel_read with path    Reads a workbook\./);
  const result = await run("excel_read @/data.xlsx", { root, tools });
  assert.deepEqual(result.errors.map((e) => e.message), ["no to data.xlsx"]);
});

test("an untrusted host tool's result and error make the session untrusted", async () => {
  const root = await project();
  const tools = { issues: { untrusted: true, run: async () => "text from outside" } };
  assert.deepEqual((await run("print the session is untrusted", { root })).output, ["false"]);
  assert.deepEqual((await run("print issues", { root, tools })).output, ["text from outside"]);
  assert.deepEqual((await run("print the session is untrusted", { root })).output, ["true"]);
  const failing = await project();
  const bad = { issues: { untrusted: true, run: async () => { throw new Error("outside text in an error"); } } };
  assert.match((await run("issues", { root: failing, tools: bad })).errors[0].message, /Tool 'issues' failed: outside text in an error/);
  assert.deepEqual((await run("print the session is untrusted", { root: failing })).output, ["true"]);
});

test("changes: the checks of a write first, then the change is on the undo list", async () => {
  const root = await project();
  let calls = 0;
  const tools = {
    write_it: {
      params: ["path"],
      effects: { changes: "path" },
      run: async ({ args }) => {
        calls++;
        await fs.writeFile(args[0].absolute, "new text");
      },
    },
  };
  const undo = [];
  const result = await run("write_it @/out.txt", { root, tools, undo });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.changes, [{ path: "out.txt", before: null, after: "new text" }]);
  assert.deepEqual((await run("undo", { root, undo })).errors, []);
  await assert.rejects(fs.access(path.join(root, "out.txt")));
  // a protected or hidden path is refused before the tool runs
  assert.match((await run("write_it @/AGENTS.talk", { root, tools })).errors[0].message, /AGENTS.talk/);
  assert.match((await run("write_it @/.env", { root, tools })).errors[0].message, /hidden|\.env/);
  assert.equal(calls, 1);
  // a before change hook guards it, as for a write
  const guarded = await project("before change\n  if the change's path starts with 'locked/' then reject 'locked' end\nend");
  assert.deepEqual((await run("write_it @/locked/a.txt", { root: guarded, tools })).errors.map((e) => e.message), ["locked"]);
  assert.equal(calls, 1);
});

test("changes to a file that is not UTF-8 text give a warning, and no undo entry", async () => {
  const root = await project();
  const tools = { write_bytes: { params: ["path"], effects: { changes: "path" }, run: async ({ args }) => fs.writeFile(args[0].absolute, Buffer.from([0xff, 0xfe, 0x00])) } };
  const result = await run("write_bytes @/book.xlsx", { root, tools });
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.warnings.map((w) => w.message), ["write_bytes changed book.xlsx, which is not UTF-8 text, so undo cannot put it back"]);
});

test("sends asks the human before each call; no or no answer stops it", async () => {
  const root = await project();
  let calls = 0;
  const asked = [];
  const tools = { post_issue: { params: ["title"], effects: { sends: true }, run: async () => ++calls } };
  const ask = (answer) => async ({ question, choices }) => {
    asked.push({ question, choices });
    return answer;
  };
  assert.deepEqual((await run("print post_issue 'hello'", { root, tools, ask: ask("yes") })).output, ["1"]);
  assert.deepEqual(asked[0], { question: "post_issue (hello): this sends data out of this machine. Allow it?", choices: ["yes", "no"] });
  assert.match((await run("post_issue 'again'", { root, tools, ask: ask("no") })).errors[0].message, /The human did not approve post_issue/);
  assert.match((await run("post_issue 'again'", { root, tools })).errors[0].message, /The human did not approve post_issue/);
  assert.equal(calls, 1);
});