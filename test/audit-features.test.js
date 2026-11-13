import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "../src/js/clank-talk.js";

// features from the audit review of 2026-11-12; see src/md/features/language.md and infrastructure/host.md

const dirs = [];

after(async () => {
  for (const dir of dirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function project(files = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "clank-audit-features-"));
  dirs.push(root);
  for (const name of Object.keys(files)) {
    await fs.writeFile(path.join(root, name), files[name]);
  }
  return root;
}

const messages = (result) => result.errors.map((error) => error.message);

test("a text-block replace must match one place; replace every changes all", async () => {
  const root = await project({ "a.js": "x = 1\ny = 2\nx = 1\n", "b.js": "z = 3\n" });
  // two places: an error, and the file does not change
  const two = await run("replace\n| x = 1\nwith\n| x = 9\nin @/a.js", { root });
  assert.deepEqual(messages(two), ["The text block matches 2 places in a.js (lines 1, 3). It must match one place. Make the old text longer, or write replace every"]);
  assert.equal(await fs.readFile(path.join(root, "a.js"), "utf8"), "x = 1\ny = 2\nx = 1\n");
  // no place: an error, not a warning
  const none = await run("in @/b.js replace\n| q = 1\nwith\n| q = 2", { root });
  assert.deepEqual(messages(none), ["The text block matches no place in b.js. The old text must be exactly as it is there, with its spaces. Read it again"]);
  // one place: done
  assert.deepEqual(messages(await run("in @/a.js replace\n| y = 2\nwith\n| y = 5", { root })), []);
  // replace every: all places
  assert.deepEqual(messages(await run("replace every\n| x = 1\nwith\n| x = 9\nin @/a.js", { root })), []);
  assert.equal(await fs.readFile(path.join(root, "a.js"), "utf8"), "x = 9\ny = 5\nx = 9\n");
  // a quoted string keeps the old rule: every match
  assert.deepEqual(messages(await run("replace 'x = 9' with 'x = 0' in @/a.js", { root })), []);
  assert.equal(await fs.readFile(path.join(root, "a.js"), "utf8"), "x = 0\ny = 5\nx = 0\n");
});

test("because: the reason goes in the audit with the command's steps", async () => {
  const root = await project({ "a.txt": "one\n", "b.txt": "b\n" });
  const audit = { scripts: 0, records: [] };
  const result = await run("# fix a typo\nreplace 'one' with 'two' in @/a.txt because 'Carson asked for it'\nread @/b.txt", { root, audit });
  assert.deepEqual(result.errors, []);
  const replace = audit.records.find((record) => record.kind === "replace");
  assert.equal(replace.because, "Carson asked for it");
  assert.equal(replace.line, 2);
  // the reason is only for its own command
  const read = audit.records.find((record) => record.kind === "read" && record.target === "b.txt");
  assert.equal(read.because, undefined);
  assert.equal(read.line, 3);
  const day = (await fs.readdir(path.join(root, ".talk", "audit"))).find((name) => name.endsWith(".log"));
  const text = await fs.readFile(path.join(root, ".talk", "audit", day), "utf8");
  assert.match(text, /replace  a\.txt +1 match, line 1  because: Carson asked for it  \(line 2\)/);
  // because needs a value
  assert.ok((await run("print 1 because", { root })).errors.length > 0);
});

test("a host session warns once about a script with no # purpose line", async () => {
  const root = await project();
  const audit = { scripts: 0, records: [] };
  const warned = (result) => result.warnings.some((warning) => warning.message.startsWith("Start the script with a # line"));
  assert.equal(warned(await run("# a purpose\nprint 1", { root, audit })), false);
  assert.equal(warned(await run("print 1", { root, audit })), true);
  assert.equal(warned(await run("print 2", { root, audit })), false);
  // with no host session (no audit), no warning
  assert.equal(warned(await run("print 1", { root })), false);
});

test("lines <n> after <line> and lines <n> before <line>", async () => {
  const root = await project({ "a.js": "one\ntwo\nthree\nfour\nfive\n" });
  const result = await run("set hit to first of find 'three' in @/a.js\nprint lines 2 after hit\nprint lines 5 before hit\nset t to 'a\\nb\\nc'\nset b to first of find 'b' in t\nprint lines 1 after b of t", { root });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.output, ["4: four\n5: five", "1: one\n2: two", "3: c"]);
  // a line from text has no file, so the text must be named
  const none = await run("set t to 'a\\nb'\nset b to first of find 'b' in t\nprint lines 1 before b", { root });
  assert.match(none.errors[0].message, /This line has no file/);
  assert.match((await run("print lines 2 after 5", { root })).errors[0].message, /needs a line, such as one from find/);
  // lines alone is still a plain word
  assert.deepEqual((await run("set lines to 3\nprint lines", { root })).output, ["3"]);
});

test("demo fixes: paths that read as variables or text, folders, check of a condition, text paths for host tools", async () => {
  const root = await project({ "README.md": "hi\n" });
  assert.deepEqual(messages(await run("read README.md", { root })), ["Unknown variable 'README'. If README.md is a file, write it as a path, with no quotes: @/README.md or ./README.md"]);
  assert.deepEqual(messages(await run("read './README.md'", { root })), ["Expected a file, found the text './README.md'. Write the path with no quotes: ./README.md"]);
  assert.deepEqual(messages(await run("find 'x' in @/", { root })), ["@/ is a folder, not a file. For its files, use a glob: for f in @/**/*"]);
  assert.match(messages(await run("check @/README.md exists", { root }))[0], /^check parses ClankTalk text, and found true\. To test a condition, use if/);
  // a host tool gets the file the runtime checked, also from text
  let given = null;
  const tools = { excel_read: { params: ["path"], effects: { reads: "path" }, run: async ({ args, named }) => { given = named.path || args[0]; return "ok"; } } };
  assert.deepEqual(messages(await run("excel_read with path: '@/README.md'", { root, tools })), []);
  assert.equal(given.path, "README.md");
  assert.deepEqual(messages(await run("excel_read './README.md'", { root, tools })), []);
  assert.equal(given.path, "README.md");
});

test("list a folder: one level, or all of it", async () => {
  const root = await project({ "a.txt": "a\n", ".env": "SECRET=12345678\n" });
  await fs.mkdir(path.join(root, "notes"));
  await fs.writeFile(path.join(root, "notes", "m1.md"), "x\n");
  const one = await run("list @/", { root });
  assert.deepEqual(one.errors, []);
  assert.deepEqual(one.output, ["a.txt\nnotes/"]);
  assert.deepEqual((await run("list all of @/", { root })).output, ["a.txt\nnotes/m1.md"]);
  assert.deepEqual((await run("set files to list @/notes/\nprint files's length", { root })).output, ["1"]);
  assert.match(messages(await run("list @/a.txt", { root }))[0], /a\.txt is not a folder/);
  // list is a command word, as read and find are; the undo list still works
  assert.match(messages(await run("set list to [1, 2]", { root }))[0], /'list' is a command word/);
  assert.deepEqual((await run("print the undo list", { root })).errors, []);
});

test("shell words point to ClankTalk, and a parse error shows an example of its command", async () => {
  const root = await project();
  assert.deepEqual(messages(await run("help ls", { root })), ["No help for 'ls'. ClankTalk has no ls. Use: list @/. Use help to list everything"]);
  assert.deepEqual(messages(await run("cat @/a.txt", { root })), ["Unknown command 'cat'. ClankTalk has no cat. Use: read @/a.txt"]);
  const { formatResult } = await import("../src/js/host.js");
  const script = "# a bad replace\nreplace 'a' in @/b.txt";
  const text = formatResult(await run(script, { root }), script, root);
  assert.match(text, /\n  Example: replace 'var ' with 'let ' in \.\/src\/app\.js/);
  // a run-time error has no example: the form was right
  const runtime = "# divide\nprint 1 / 0";
  assert.doesNotMatch(formatResult(await run(runtime, { root }), runtime, root), /Example:/);
});

test("a text-block replace in a list of files: at most one place in each file, and nothing changes on an error", async () => {
  const root = await project({ "a.js": "k = 1\n", "b.js": "k = 1\nk = 1\n", "c.js": "m = 1\n" });
  const result = await run("replace\n| k = 1\nwith\n| k = 2\nin [@/a.js, @/b.js]", { root });
  assert.deepEqual(messages(result), ["The text block matches 2 places in b.js (lines 1, 2). It must match one place. Make the old text longer, or write replace every"]);
  assert.equal(await fs.readFile(path.join(root, "a.js"), "utf8"), "k = 1\n");
  assert.deepEqual(messages(await run("replace\n| k = 1\nwith\n| k = 2\nin [@/a.js, @/c.js]", { root })), []);
  assert.equal(await fs.readFile(path.join(root, "a.js"), "utf8"), "k = 2\n");
});