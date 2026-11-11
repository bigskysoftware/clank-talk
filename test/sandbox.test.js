import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { sandboxKind, installDirs, sandboxPlan, macosProfile, bwrapArgs, wrapCommand, selfTest } from "../src/js/sandbox.js";

// the real sandbox tests cannot run inside a sandbox: a sandbox cannot start inside another
const realKind = process.env.CLANK_TALK_SANDBOXED === "1" ? null : (await sandboxKind()).kind;
const realMac = realKind === "macos";
const realLinux = realKind === "linux";

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

test("installDirs never gives /, the home folder, or a folder above it", async () => {
  // on Linux, /bin is often a link to /usr/bin, so /usr can be there too
  const shDirs = await installDirs("sh", "/bin");
  assert.ok(shDirs.includes("/bin"), shDirs.join(", "));
  assert.ok(!shDirs.includes("/"), shDirs.join(", "));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "clank-home-"));
  try {
    await fs.mkdir(path.join(home, "bin"));
    await fs.writeFile(path.join(home, "bin", "tool"), "#!/bin/sh\n", { mode: 0o755 });
    const dirs = await installDirs("tool", path.join(home, "bin"), home);
    assert.deepEqual(dirs, [path.join(home, "bin"), path.join(await fs.realpath(home), "bin")].filter((dir, index, all) => all.indexOf(dir) === index));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
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
  assert.doesNotMatch(macosProfile({ ...plan, listen: true }), /network-outbound/);
  const local = macosProfile({ ...plan, localNetwork: true });
  assert.match(local, /\(allow network-outbound \(remote ip "localhost:\*"\)\)/);
  assert.doesNotMatch(local, /\(allow network\*\)/);
  await assert.rejects(sandboxPlan({ root: '/p/a"b', tmp: "/t" }), /cannot hold a quote/);
});

test("a reads of line that names a secret path opens it; a parent path does not", async () => {
  const home = await fs.realpath(os.homedir());
  const named = await sandboxPlan({ root: "/p/proj", tmp: "/t/x", reads: ["~/.config/gh"] });
  assert.deepEqual(named.opened, [{ path: path.join(home, ".config/gh"), write: false }]);
  const profile = macosProfile(named);
  const deny = profile.indexOf("(deny file-read*");
  const allow = profile.indexOf('(allow file-read* (subpath "' + path.join(home, ".config/gh") + '"))');
  assert.ok(deny !== -1 && allow > deny, "the allow comes after the deny, so it wins");
  assert.match(profile, /\.ssh"\)/);
  const parent = await sandboxPlan({ root: "/p/proj", tmp: "/t/x", reads: ["~"] });
  assert.deepEqual(parent.opened, []);
  const inside = await sandboxPlan({ root: "/p/proj", tmp: "/t/x", writes: ["~/.config/gh/hosts.yml"] });
  assert.deepEqual(inside.opened, [{ path: path.join(home, ".config/gh/hosts.yml"), write: true }]);
  assert.match(macosProfile(inside), /\(allow file-write\* \(subpath "[^"]*\.config\/gh\/hosts\.yml"\)\)/);
  const args = (await bwrapArgs({ ...named, root: "/p/proj", tmp: "/t/x" }, "/p/proj")).join(" ");
  assert.ok(args.lastIndexOf("--ro-bind-try " + path.join(home, ".config/gh")) > args.indexOf(path.join(home, ".ssh")));
});


test("the sandbox really holds", { skip: realKind === null }, async () => {
  assert.deepEqual(await selfTest(realKind), { ok: true, problems: [] });
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
      "console.log(['a.txt', 'src/b.txt', '.git/x', '.env', 'src/.hidden', 'x.talk', 'talk/y', '.github/ci.yml', '.github/x.talk', '../outside.txt'].map(tryIt).join(' '));",
    ].join("\n");
    const wrapped = await wrapCommand("macos", plan, "node", ["-e", script], plan.root);
    const out = execFileSync(wrapped.program, wrapped.args, { cwd: plan.root, env: { PATH: process.env.PATH, TMPDIR: tmp }, encoding: "utf8" });
    assert.equal(out.trim(), "yes yes no no no no no yes no no");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("on Linux: a sandboxed program can write the project, but not .git, outside, or a protected file that exists", { skip: !realLinux }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "clank-sbx-t-"));
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "clank-sbx-tt-"));
  await fs.mkdir(path.join(root, ".git"));
  await fs.mkdir(path.join(root, "talk"));
  await fs.writeFile(path.join(root, ".env"), "SECRET=1");
  await fs.writeFile(path.join(root, "x.talk"), "tool a\nend\n");
  try {
    const plan = await sandboxPlan({ root, tmp, programDirs: await installDirs("node", process.env.PATH), allowedChanges: [".github"] });
    const script = [
      "const fs = require('fs');",
      "const tryIt = (p) => { try { fs.mkdirSync(require('path').dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'); return 'yes'; } catch (e) { return 'no'; } };",
      "console.log(['a.txt', 'src/b.txt', '.git/x', '.env', 'x.talk', 'talk/y', '.github/ci.yml'].map(tryIt).join(' '));",
      // /tmp in the sandbox is private, so this write can work there; the host checks that it did not reach the real /tmp
      "tryIt('../outside.txt');",
      "try { console.log(fs.readFileSync('.env', 'utf8')); } catch (e) { console.log('refused'); }",
    ].join("\n");
    const wrapped = await wrapCommand("linux", plan, "node", ["-e", script], plan.root);
    const out = execFileSync(wrapped.program, wrapped.args, { cwd: plan.root, env: { PATH: process.env.PATH, TMPDIR: tmp }, encoding: "utf8" });
    const [writes, secret] = out.trim().split("\n");
    assert.equal(writes, "yes yes no no no no yes");
    assert.doesNotMatch(secret, /SECRET/);
    assert.equal(await fs.readFile(path.join(root, ".env"), "utf8"), "SECRET=1");
    await assert.rejects(fs.access(path.join(path.dirname(root), "outside.txt")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("bwrap hides a secret file with /dev/null and a secret folder with an empty folder", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "clank-bwrap-"));
  try {
    await fs.writeFile(path.join(root, ".env"), "SECRET=1");
    await fs.mkdir(path.join(root, ".ssh"));
    await fs.writeFile(path.join(root, ".netrc"), "machine x");
    const plan = { network: false, reads: [], writes: [], root, tmp: root, allowedChanges: [], secrets: [path.join(root, ".ssh"), path.join(root, ".netrc"), path.join(root, ".aws")] };
    const args = (await bwrapArgs(plan, root)).join(" ");
    assert.match(args, new RegExp("--ro-bind /dev/null " + path.join(root, ".env")));
    assert.match(args, new RegExp("--tmpfs " + path.join(root, ".ssh")));
    assert.match(args, new RegExp("--ro-bind /dev/null " + path.join(root, ".netrc")));
    assert.doesNotMatch(args, /\.aws/);
    assert.doesNotMatch(args, new RegExp("--tmpfs " + path.join(root, ".env")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
