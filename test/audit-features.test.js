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

test("a text-block replace in a list of files: at most one place in each file, and nothing changes on an error", async () => {
  const root = await project({ "a.js": "k = 1\n", "b.js": "k = 1\nk = 1\n", "c.js": "m = 1\n" });
  const result = await run("replace\n| k = 1\nwith\n| k = 2\nin [@/a.js, @/b.js]", { root });
  assert.deepEqual(messages(result), ["The text block matches 2 places in b.js (lines 1, 2). It must match one place. Make the old text longer, or write replace every"]);
  assert.equal(await fs.readFile(path.join(root, "a.js"), "utf8"), "k = 1\n");
  assert.deepEqual(messages(await run("replace\n| k = 1\nwith\n| k = 2\nin [@/a.js, @/c.js]", { root })), []);
  assert.equal(await fs.readFile(path.join(root, "a.js"), "utf8"), "k = 2\n");
});