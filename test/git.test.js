import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { unsafeConfig, guardArgs, gitEnv, isSafeBranchName, isSafeCommitName, HOOK_EVENTS } from "../src/js/git.js";

test("unsafeConfig refuses repo keys that run programs", () => {
  const list = [
    "global\tcore.pager=less",
    "local\tcore.filemode=true",
    "local\tuser.name=t",
    "local\tremote.origin.url=git@github.com:a/b.git",
    "local\tcore.fsmonitor=./evil",
    "local\thook.Evil.command=echo x",
    "local\tfilter.lfs.clean=git-lfs clean -- %f",
    "local\tdiff.pdf.textconv=pdftotext",
    "local\tremote.x.url=ext::sh -c evil",
    "local\talias.st=!sh",
    "worktree\tinclude.path=../other",
  ].join("\n");
  assert.deepEqual(unsafeConfig(list), [
    "core.fsmonitor=./evil",
    "hook.Evil.command=echo x",
    "filter.lfs.clean=git-lfs clean -- %f",
    "diff.pdf.textconv=pdftotext",
    "remote.x.url=ext::sh -c evil",
    "alias.st=!sh",
    "include.path=../other",
  ]);
});

test("guardArgs turns off hooks for every event", () => {
  const args = guardArgs();
  assert.equal(args[0], "--no-pager");
  for (const event of HOOK_EVENTS) {
    assert.ok(args.includes("hook." + event + ".enabled=false"), event);
  }
});

test("gitEnv keeps only PATH and HOME", () => {
  assert.deepEqual(gitEnv({ PATH: "/bin", HOME: "/h", GIT_EXTERNAL_DIFF: "evil", SECRET: "x" }), { GIT_TERMINAL_PROMPT: "0", PATH: "/bin", HOME: "/h" });
});

test("branch and commit names", () => {
  for (const name of ["main", "feature-x", "user/fix_1", "v1.2"]) {
    assert.equal(isSafeBranchName(name), true, name);
  }
  for (const name of ["-x", "--force", "a..b", "a/", "a.lock", "a b", "", "a;b", "a//b"]) {
    assert.equal(isSafeBranchName(name), false, name);
  }
  assert.equal(isSafeCommitName("HEAD~2"), true);
  assert.equal(isSafeCommitName("a1b2c3d"), true);
  assert.equal(isSafeCommitName("--output=x"), false);
  assert.equal(isSafeCommitName("a..b"), false);
});

test("with real git: the guards stop a config hook, and unsafeConfig sees it", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clank-git-"));
  const git = (args) => execFileSync("git", args, { cwd: dir, env: gitEnv(process.env), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    git(["init", "-q"]);
    git(["config", "user.email", "t@t"]);
    git(["config", "user.name", "t"]);
    const marker = path.join(dir, "hook-ran");
    git(["config", "hook.evil.command", "touch " + marker]);
    git(["config", "--add", "hook.evil.event", "pre-commit"]);
    git(["config", "--add", "hook.evil.event", "post-commit"]);
    await fs.writeFile(path.join(dir, "a"), "a");
    git(["add", "a"]);
    git([...guardArgs(), "commit", "-q", "--no-verify", "-m", "one"]);
    await assert.rejects(fs.access(marker));
    assert.deepEqual(unsafeConfig(git(["config", "list", "--show-scope"])), ["hook.evil.command=touch " + marker, "hook.evil.event=pre-commit", "hook.evil.event=post-commit"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
