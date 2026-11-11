import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { run } from "../src/js/clank-talk.js";
import { printable } from "../src/js/untrusted.js";

// fixes from the security review of 2026-11-10; see src/md/features/hooks.md and git.md

const HOOK = "before change\n  if the change's path is in @/migrations/\n    reject 'A human writes the migrations'\n  end\nend\n";
const NO = "A human writes the migrations";
let root;

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH, HOME: root } });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "clank-review-"));
  await fs.mkdir(path.join(root, "migrations"));
  await fs.writeFile(path.join(root, "migrations", "001.sql"), "create table a;\n");
  await fs.writeFile(path.join(root, "AGENTS.talk"), HOOK);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function errors(source) {
  return (await run(source, { root })).errors.map((e) => e.message);
}

test("is in a folder: another letter case is the same folder where the file system ignores case", { skip: !["darwin", "win32"].includes(process.platform) }, async () => {
  assert.deepEqual(await errors("write 'x' to @/Migrations/b.sql"), [NO]);
  assert.deepEqual(await errors("print 'MIGRATIONS/a.sql' is in @/migrations/"), []);
  assert.equal((await run("print 'MIGRATIONS/a.sql' is in @/migrations/", { root })).output[0], "true");
});

test("is in a folder: a link to the folder is the folder", async () => {
  await fs.symlink("migrations", path.join(root, "mlink"));
  assert.deepEqual(await errors("write 'x' to @/mlink/g.sql"), [NO]);
  await assert.rejects(fs.stat(path.join(root, "migrations", "g.sql")));
});

test("move runs the change hooks for the target too, so a move into the folder is refused", async () => {
  await fs.writeFile(path.join(root, "s.sql"), "drop table users;\n");
  assert.deepEqual(await errors("move @/s.sql to @/migrations/002.sql"), [NO]);
  assert.deepEqual(await errors("move @/migrations/001.sql to @/gone.sql"), [NO]);
  await assert.rejects(fs.stat(path.join(root, "migrations", "002.sql")));
});

test("git move, merge and stash run the change hooks for the files they change, before they change them", async () => {
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  await fs.writeFile(path.join(root, "evil.sql"), "drop table users;\n");
  git(["add", "migrations/001.sql", "evil.sql"]);
  git(["commit", "-q", "-m", "first"]);
  assert.deepEqual(await errors("git move @/evil.sql to @/migrations/002.sql"), [NO]);
  assert.deepEqual(await errors("git move @/migrations/001.sql to @/gone.sql"), [NO]);
  // a branch that adds a migration: the merge is refused, and nothing changes
  git(["switch", "-q", "-c", "side"]);
  await fs.writeFile(path.join(root, "migrations", "003.sql"), "drop table b;\n");
  git(["add", "migrations/003.sql"]);
  git(["commit", "-q", "-m", "side"]);
  git(["switch", "-q", "main"]);
  assert.deepEqual(await errors("git merge 'side'"), [NO]);
  assert.deepEqual(await errors("git switch to 'side'"), [NO]);
  await assert.rejects(fs.stat(path.join(root, "migrations", "003.sql")));
  // a stash would put the migration back as it was in the commit
  await fs.writeFile(path.join(root, "migrations", "001.sql"), "changed by a human\n");
  assert.deepEqual(await errors("git stash"), [NO]);
  assert.equal(await fs.readFile(path.join(root, "migrations", "001.sql"), "utf8"), "changed by a human\n");
});

test("is in with no / and no such folder is a clear error", async () => {
  assert.match((await errors("print 'a.sql' is in @/nothing"))[0], /^There is no folder nothing\. To check a folder, write it with a \/ at the end/);
});

test("the audit shows named tool arguments", async () => {
  await fs.writeFile(path.join(root, "AGENTS.talk"), "tool deploy with target\n  set the result to target\nend\n");
  const result = await run("deploy with target: 'prod'\nfor step in the audit\n  if step's kind is 'tool'\n    print step's details\n  end\nend", { root });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.output, ["target: prod"]);
});

test("printable removes the format characters that hide text or change its direction", () => {
  assert.equal(printable("a‮b c​d⁦e﻿f"), "a?b?c?d?e?f");
});

test("a policy with two lines for one limit is an error", async () => {
  const policy = { name: "p.talk", source: "policy 'p'\nlimit fetch from 'example.com', 'example.org'\nlimit fetch from 'example.com'" };
  assert.match((await run("print 1", { root, policy })).errors[0].message, /^Only one 'limit fetch' line is allowed in a policy/);
});

test("limit output keeping lines matching: a pattern that runs too long still cuts", async () => {
  await fs.writeFile(path.join(root, "AGENTS.talk"), "limit output keeping lines matching pattern /^(a+)+$/ or 1 KB\n");
  const result = await run("repeat 600 times\n  print 'a'\nend\nprint 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!'", { root });
  assert.match(result.warnings.map((w) => w.message).join("\n"), /'limit output' could not use its pattern \(.*time/i);
  assert.ok(Buffer.byteLength(result.shown) < 1200);
});
