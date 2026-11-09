import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { sandboxKind, installDirs, sandboxPlan, macosProfile, wrapCommand, selfTest } from "../src/js/sandbox.js";

// the real sandbox tests cannot run inside a sandbox: a sandbox cannot start inside another
const realMac = process.platform === "darwin" && process.env.CLANK_TALK_SANDBOXED !== "1";

test("sandboxKind: macOS, Linux with bwrap, and nothing else", async () => {
  assert.match((await sandboxKind("darwin", "", { CLANK_TALK_SANDBOXED: "1" })).reason, /already runs in a ClankTalk sandbox/);
  assert.equal((await sandboxKind("win32", "", {})).kind, null);
  assert.match((await sandboxKind("win32", "", {})).reason, /no sandbox for win32/);
  assert.match((await sandboxKind("linux", "", {})).reason, /bubblewrap is not installed/);
  if (realMac) {
    assert.equal((await sandboxKind("darwin")).kind, "macos");
  }
});

test("installDirs finds the folder above bin/", async () => {
  const dirs = await installDirs("node", process.env.PATH);
  assert.ok(dirs.length > 0);
  assert.ok(dirs.some((dir) => process.execPath.startsWith(dir)), dirs.join(", "));
  assert.deepEqual(await installDirs("no-such-program-x", process.env.PATH), []);
});

test("the macOS profile: deny by default, the project, no secrets, network only if asked", async () => {
  const plan = await sandboxPlan({ root: "/p/proj", tmp: "/t/x", programDirs: ["/opt/node"], allowedChanges: [".github"] });
  const profile = macosProfile(plan);
  assert.match(profile, /^\(version 1\)\n\(deny default\)/);
  assert.match(profile, /\(allow file-write\* \(subpath "\/p\/proj"\)/);
  assert.match(profile, /\(deny file-write\* \(subpath "\/p\/proj\/\.git"\)/);
  assert.match(profile, /\(allow file-write\* \(subpath "\/p\/proj\/\.github"\)\)/);
  assert.match(profile, /\.ssh"\)/);
  assert.doesNotMatch(profile, /network/);
  assert.match(macosProfile({ ...plan, network: true }), /\(allow network\*\)/);
  assert.match(macosProfile({ ...plan, listen: true }), /network-bind \(local ip "localhost:\*"\)/);
  await assert.rejects(sandboxPlan({ root: '/p/a"b', tmp: "/t" }), /cannot hold a quote/);
});

test("on macOS, the sandbox really holds", { skip: !realMac }, async () => {
  assert.deepEqual(await selfTest("macos"), { ok: true, problems: [] });
});

test("on macOS: a sandboxed program can write the project, but not .git, a hidden file, or outside", { skip: !realMac }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "clank-sbx-t-"));
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "clank-sbx-tt-"));
  await fs.mkdir(path.join(root, ".git"));
  try {
    const plan = await sandboxPlan({ root, tmp, programDirs: await installDirs("node", process.env.PATH), allowedChanges: [".github"] });
    const script = [
      "const fs = require('fs');",
      "const tryIt = (p) => { try { fs.mkdirSync(require('path').dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'); return 'yes'; } catch (e) { return 'no'; } };",
      "console.log(['a.txt', 'src/b.txt', '.git/x', '.env', 'src/.hidden', 'x.talk', 'talk/y', '.github/ci.yml', '../outside.txt'].map(tryIt).join(' '));",
    ].join("\n");
    const wrapped = await wrapCommand("macos", plan, "node", ["-e", script], plan.root);
    const out = execFileSync(wrapped.program, wrapped.args, { cwd: plan.root, env: { PATH: process.env.PATH, TMPDIR: tmp }, encoding: "utf8" });
    assert.equal(out.trim(), "yes yes no no no no no yes no");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
