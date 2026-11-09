import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { run } from "../src/js/clank-talk.js";

// a temporary repo with one commit, and one changed file
let root;

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH, HOME: root } });
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "clank-gitcmd-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  await fs.writeFile(path.join(root, "a.txt"), "one\n");
  await fs.writeFile(path.join(root, "b.txt"), "two\n");
  git(["add", "a.txt", "b.txt"]);
  git(["commit", "-q", "-m", "first"]);
  await fs.writeFile(path.join(root, "a.txt"), "one\nmore\n");
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function output(source) {
  const result = await run(source, { root });
  assert.deepEqual(result.errors, []);
  return result.output;
}

async function errors(source) {
  const result = await run(source, { root });
  return result.errors.map((e) => e.message);
}

test("git status, branch and branches", async () => {
  assert.deepEqual(await output("git status\nprint it"), ["## main\n M a.txt\n"]);
  assert.deepEqual(await output("git branch\nprint it"), ["main\n"]);
  assert.deepEqual(await output("git branches\nprint it"), ["* main\n"]);
});

test("git diff, of all files or some", async () => {
  const [all] = await output("git diff\nprint it");
  assert.match(all, /\+more/);
  assert.deepEqual(await output("git diff ./b.txt\nprint it"), [""]);
  assert.match((await output("git diff [./a.txt, ./b.txt]\nprint it"))[0], /\+more/);
});

test("git log and git show", async () => {
  assert.match((await output("git log\nprint it"))[0], /^[0-9a-f]+ first\n$/);
  assert.match((await output("git log 1\nprint it"))[0], /first/);
  assert.match((await output("git show 'HEAD'\nprint it"))[0], /first/);
});

test("git checks the values from the script", async () => {
  assert.deepEqual(await errors("git show '--output=x'"), ["Not a safe commit name: '--output=x'. Use a commit id, a branch name, or HEAD~1"]);
  assert.deepEqual(await errors("git log 0"), ["git log needs a whole number above 0, found 0"]);
  assert.deepEqual(await errors("git diff 'a.txt'"), ["git diff needs a file or a list of files, found 'a.txt'"]);
  assert.deepEqual(await errors("git diff ./nothing/*.txt"), ["git diff found no files to show"]);
});

test("git is turned off when the repo config can run programs", async () => {
  git(["config", "core.pager", "touch pager-ran"]);
  try {
    const [message] = await errors("git status");
    assert.equal(message, "Git is turned off here, because the repo config can run programs: core.pager=touch pager-ran\nA human must remove these settings from .git/config.");
  } finally {
    git(["config", "--unset", "core.pager"]);
  }
});

test("a git error is a script error", async () => {
  assert.match((await errors("git show 'nope'"))[0], /^git show failed: fatal/);
});

test("hooks can watch git", async () => {
  await fs.writeFile(path.join(root, "AGENTS.talk"), "before git\n  if the git's operation is 'log'\n    reject 'no log'\n  end\nend");
  try {
    assert.deepEqual(await errors("git log"), ["no log"]);
    assert.deepEqual((await output("git branch\nprint it")), ["main\n"]);
  } finally {
    await fs.rm(path.join(root, "AGENTS.talk"));
  }
});

test("git switch to a new branch, then back", async () => {
  await output("git switch to new branch 'feature-x'");
  assert.equal(git(["branch", "--show-current"]), "feature-x\n");
  await output("git switch to 'main'");
  assert.equal(git(["branch", "--show-current"]), "main\n");
  assert.deepEqual(await errors("git switch to '--detach'"), ["Not a safe branch name: '--detach'. Use letters, digits, -, _, / and ."]);
});

test("git commit commits only the named files, new ones too", async () => {
  await fs.writeFile(path.join(root, "new.txt"), "new\n");
  await fs.writeFile(path.join(root, "b.txt"), "two\nchanged\n");
  await output("git commit [./a.txt, ./new.txt] with 'Second commit'");
  assert.equal(git(["log", "-1", "--format=%s"]), "Second commit\n");
  assert.equal(git(["show", "--name-only", "--format=", "HEAD"]), "a.txt\nnew.txt\n");
  // b.txt is still changed, and not committed
  assert.equal(git(["status", "--short"]), " M b.txt\n");
  git(["checkout", "--", "b.txt"]);
  await fs.writeFile(path.join(root, "a.txt"), "one\nmore\n");
});

test("git commit checks its values", async () => {
  await fs.writeFile(path.join(root, ".env"), "SECRET=1\n");
  try {
    assert.match((await errors("git commit ./.env with 'oops'"))[0], /^A script cannot commit hidden files or folders/);
    assert.deepEqual(await errors("git commit ./a.txt with ''"), ["A commit needs a message"]);
    assert.deepEqual(await errors("git commit [] with 'x'"), ["git commit found no files to commit"]);
  } finally {
    await fs.rm(path.join(root, ".env"));
  }
});

test("git merge is fast-forward only", async () => {
  await output("git switch to new branch 'ahead'");
  await fs.writeFile(path.join(root, "c.txt"), "c\n");
  await output("git commit ./c.txt with 'Add c'");
  await output("git switch to 'main'");
  await output("git merge 'ahead'");
  assert.equal(git(["log", "-1", "--format=%s"]), "Add c\n");
  // main and ahead both move on: not a fast-forward, so the merge fails
  await output("git switch to 'ahead'");
  await fs.writeFile(path.join(root, "d.txt"), "d\n");
  await output("git commit ./d.txt with 'Add d'");
  await output("git switch to 'main'");
  await fs.writeFile(path.join(root, "e.txt"), "e\n");
  await output("git commit ./e.txt with 'Add e'");
  assert.match((await errors("git merge 'ahead'"))[0], /^git merge failed: /);
  assert.deepEqual(await errors("git merge '-s'"), ["Not a safe branch name: '-s'. Use letters, digits, -, _, / and ."]);
});
