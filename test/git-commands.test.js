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

test("git commit takes no folders and no pathspec magic, so it cannot commit a hidden file", async () => {
  await fs.mkdir(path.join(root, "sub"));
  await fs.writeFile(path.join(root, "sub", ".env"), "SECRET=1\n");
  await fs.writeFile(path.join(root, ".env"), "SECRET=1\n");
  try {
    assert.deepEqual(await errors("git commit ./sub with 'x'"), ["git commit needs files, not a folder: sub. Name the files, for example with a glob: @/sub/**/*"]);
    assert.equal((await errors(`git commit ./":(top).env" with 'x'`)).length, 1);
    assert.equal((await errors(`git commit ./":/" with 'x'`)).length, 1);
    assert.doesNotMatch(git(["log", "--all", "--name-only", "--format="]), /\.env/);
  } finally {
    await fs.rm(path.join(root, "sub"), { recursive: true });
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

test("git push asks the human, unless AGENTS.talk allows it", async () => {
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), "clank-origin-"));
  execFileSync("git", ["init", "-q", "--bare", bare]);
  git(["remote", "add", "origin", bare]);
  const remoteLog = () => execFileSync("git", ["log", "--oneline", "-1", "main"], { cwd: bare, encoding: "utf8" });
  try {
    const questions = [];
    const no = async (request) => {
      questions.push(request.question);
      return "no";
    };
    let result = await run("git push", { root, ask: no });
    assert.match(result.errors[0].message, /^The human did not approve the push\. Nothing was pushed\.\nTo push without asking/);
    assert.deepEqual(questions, ["Push branch 'main' to origin?"]);
    assert.throws(() => remoteLog());

    result = await run("git push", { root });
    assert.match(result.errors[0].message, /^The human did not approve the push: there is no way to ask them here/);

    result = await run("git push", { root, ask: async () => "yes" });
    assert.deepEqual(result.errors, []);
    assert.equal(remoteLog(), git(["log", "--oneline", "-1"]));

    await fs.writeFile(path.join(root, "AGENTS.talk"), "allow git push");
    await fs.writeFile(path.join(root, "f.txt"), "f\n");
    await output("git commit ./f.txt with 'Add f'");
    result = await run("git push", { root, ask: no });
    assert.deepEqual(result.errors, []);
    assert.equal(questions.length, 1);
    assert.equal(remoteLog(), git(["log", "--oneline", "-1"]));
  } finally {
    await fs.rm(path.join(root, "AGENTS.talk"), { force: true });
    git(["remote", "remove", "origin"]);
    await fs.rm(bare, { recursive: true, force: true });
  }
});

test("git delete branch deletes only a merged branch", async () => {
  await output("git switch to new branch 'done'\ngit switch to 'main'\ngit delete branch 'done'");
  assert.doesNotMatch(git(["branch", "--list"]), /done/);
  await output("git switch to new branch 'open'");
  await fs.writeFile(path.join(root, "o.txt"), "o\n");
  await output("git commit ./o.txt with 'Add o'\ngit switch to 'main'");
  assert.match((await errors("git delete branch 'open'"))[0], /^git delete failed: .*not fully merged/s);
  assert.deepEqual(await errors("git delete branch '-D'"), ["Not a safe branch name: '-D'. Use letters, digits, -, _, / and ."]);
});

test("git push with no answer in time pushes nothing, and says why", async () => {
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), "clank-origin-"));
  execFileSync("git", ["init", "-q", "--bare", bare]);
  git(["remote", "add", "origin", bare]);
  try {
    const result = await run("git push", { root, ask: () => new Promise(() => {}), askTimeLimit: 30 });
    assert.match(result.errors[0].message, /^The human did not approve the push: nobody answered in time\. Nothing was pushed\./);
  } finally {
    git(["remote", "remove", "origin"]);
    await fs.rm(bare, { recursive: true, force: true });
  }
});
