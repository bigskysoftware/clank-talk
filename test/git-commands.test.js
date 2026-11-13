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
  assert.deepEqual(await output("git status"), ["## main\n M a.txt\n"]);
  assert.deepEqual(await output("git branch"), ["main\n"]);
  assert.deepEqual(await output("git branches"), ["* main\n"]);
});

test("git diff, of all files or some", async () => {
  const [all] = await output("git diff");
  assert.match(all, /\+more/);
  assert.deepEqual(await output("git diff ./b.txt"), []);
  assert.match((await output("git diff [./a.txt, ./b.txt]"))[0], /\+more/);
});

test("git log and git show", async () => {
  assert.match((await output("git log"))[0], /^[0-9a-f]+ first\n$/);
  assert.match((await output("git log 1"))[0], /first/);
  assert.match((await output("git show 'HEAD'"))[0], /first/);
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
    assert.deepEqual((await output("git branch")), ["main\n"]);
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

test("git commit takes a list with no brackets too", async () => {
  await fs.writeFile(path.join(root, "c.txt"), "c\n");
  await fs.writeFile(path.join(root, "d.txt"), "d\n");
  await output("git commit ./c.txt, ./d.txt with 'Two files'");
  assert.equal(git(["show", "--name-only", "--format=", "HEAD"]), "c.txt\nd.txt\n");
  // the repo is shared with the next tests: take the commit and the files back
  git(["reset", "-q", "HEAD~1"]);
  await fs.rm(path.join(root, "c.txt"));
  await fs.rm(path.join(root, "d.txt"));
});

test("git commit checks its values", async () => {
  await fs.writeFile(path.join(root, ".env"), "SECRET=1\n");
  try {
    assert.match((await errors("git commit ./.env with 'oops'"))[0], /^A script cannot commit hidden files or folders/);
    assert.deepEqual(await errors("git commit ./a.txt with ''"), ["A commit needs a message"]);
    assert.deepEqual(await errors("git commit ./a.txt with null"), ["The commit message is null. Give the commit a message"]);
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

test("git push pushes the branch to origin, and never asks", async () => {
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), "clank-origin-"));
  execFileSync("git", ["init", "-q", "--bare", bare]);
  git(["remote", "add", "origin", bare]);
  const remoteLog = () => execFileSync("git", ["log", "--oneline", "-1", "main"], { cwd: bare, encoding: "utf8" });
  try {
    const questions = [];
    const result = await run("git push", { root, ask: async (request) => questions.push(request.question) });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(questions, []);
    assert.equal(remoteLog(), git(["log", "--oneline", "-1"]));
    await fs.writeFile(path.join(root, "AGENTS.talk"), "allow git push");
    assert.match((await errors("git push"))[0], /^Expected 'env', 'changes to', 'fetch from', 'secret' or 'harness tools'/);
  } finally {
    await fs.rm(path.join(root, "AGENTS.talk"), { force: true });
    git(["remote", "remove", "origin"]);
    await fs.rm(bare, { recursive: true, force: true });
  }
});

test("git push tag sends one tag to origin, and never moves a tag that is there", async () => {
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), "clank-origin-"));
  execFileSync("git", ["init", "-q", "--bare", bare]);
  git(["remote", "add", "origin", bare]);
  const remoteTags = () => execFileSync("git", ["tag", "--list"], { cwd: bare, encoding: "utf8" });
  try {
    await output("git tag 'v9.9.9'\ngit push tag 'v9.9.9'");
    assert.equal(remoteTags(), "v9.9.9\n");
    // a tag with the same name on another commit is refused: no force
    git(["tag", "-d", "v9.9.9"]);
    git(["tag", "v9.9.9", "HEAD~1"]);
    assert.match((await errors("git push tag 'v9.9.9'"))[0], /^git push failed: /);
    assert.deepEqual(await errors("git push tag '-f'"), ["Not a safe tag name: '-f'. Use letters, digits, -, _, / and ."]);
  } finally {
    git(["tag", "-d", "v9.9.9"]);
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

test("git rebase onto a branch moves the branch's commits", async () => {
  await output("git switch to 'main'\ngit switch to new branch 'topic'");
  await fs.writeFile(path.join(root, "t1.txt"), "t1\n");
  await output("git commit ./t1.txt with 'Add t1'\ngit switch to 'main'");
  await fs.writeFile(path.join(root, "m1.txt"), "m1\n");
  await output("git commit ./m1.txt with 'Add m1'\ngit switch to 'topic'\ngit rebase onto 'main'");
  assert.equal(git(["log", "-2", "--format=%s"]), "Add t1\nAdd m1\n");
});

test("git rebase stops on a conflict, and leaves the branch as it was", async () => {
  await fs.writeFile(path.join(root, "m1.txt"), "topic\n");
  await output("git commit ./m1.txt with 'Topic m1'\ngit switch to 'main'");
  await fs.writeFile(path.join(root, "m1.txt"), "main\n");
  await output("git commit ./m1.txt with 'Main m1'\ngit switch to 'topic'");
  const [message] = await errors("git rebase onto 'main'");
  assert.equal(message, "git rebase stopped: these files have conflicts, so the branch is as it was:\nm1.txt\nMerge by hand, or ask the human");
  assert.equal(git(["log", "-1", "--format=%s"]), "Topic m1\n");
  assert.equal(git(["status", "--porcelain", "--untracked-files=no"]), "");
  await assert.rejects(fs.access(path.join(root, ".git", "rebase-merge")));
});

test("git rebase checks the branch first", async () => {
  assert.deepEqual(await errors("git rebase onto 'topic'"), ["git rebase cannot put topic onto itself. Switch to the branch to move first"]);
  assert.deepEqual(await errors("git rebase onto '--exec=x'"), ["Not a safe branch name: '--exec=x'. Use letters, digits, -, _, / and ."]);
  await fs.writeFile(path.join(root, "t1.txt"), "changed\n");
  try {
    assert.match((await errors("git rebase onto 'main'"))[0], /^git rebase needs a clean branch\. Commit the changes first:\n M t1\.txt$/);
  } finally {
    git(["checkout", "--", "t1.txt"]);
  }
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), "clank-origin-"));
  execFileSync("git", ["init", "-q", "--bare", bare]);
  git(["remote", "add", "origin", bare]);
  try {
    git(["push", "-q", "origin", "topic"]);
    assert.deepEqual(await errors("git rebase onto 'main'"), ["git rebase refused: topic has commits on a remote, and a rebase rewrites them. A human must do this rebase"]);
  } finally {
    git(["remote", "remove", "origin"]);
    await fs.rm(bare, { recursive: true, force: true });
  }
});

test("git move moves a tracked file, so git sees a rename", async () => {
  await output("git switch to 'main'");
  await output("git move ./a.txt to ./moved/a.txt");
  assert.match(git(["status", "--short"]), /^R  a\.txt -> moved\/a\.txt$/m);
  await output("git commit [./moved/a.txt, ./a.txt] with 'Move a'");
  assert.equal(git(["log", "-1", "--format=%s"]), "Move a\n");
  assert.deepEqual(await errors("git move ./moved/a.txt to ./b.txt"), ["Cannot move moved/a.txt to b.txt: that file is already there. git move does not replace files"]);
  assert.match((await errors("git move ./moved/a.txt to ./.env"))[0], /^A script cannot change hidden files/);
});

test("git diff and git show do not show a .env file that is in git", async () => {
  await output("git switch to 'main'");
  await fs.writeFile(path.join(root, ".env.example"), "KEY=one\n");
  git(["add", "-f", ".env.example"]);
  git(["commit", "-q", "-m", "Add env"]);
  const [shown] = await output("git show 'HEAD'");
  assert.match(shown, /diff --git a\/\.env\.example b\/\.env\.example\n\(a \.env file: not shown, since it holds secrets\)/);
  assert.doesNotMatch(shown, /KEY=one/);
  await fs.writeFile(path.join(root, ".env.example"), "KEY=two\n");
  const [diff] = await output("git diff");
  assert.doesNotMatch(diff, /KEY=/);
  assert.deepEqual(await errors("git diff ./.env.example"), ["A script cannot read .env files, because they hold secrets: .env.example"]);
  git(["checkout", "--", ".env.example"]);
});

test("a branch name with no quotes gives an error that shows the quoted form", async () => {
  assert.deepEqual(await errors("git switch to new branch fix-parser"), ["A branch name is text, in quotes: git switch to new branch 'fix-parser'"]);
  assert.deepEqual(await errors("git merge fix-parser"), ["A branch name is text, in quotes: git merge 'fix-parser'"]);
  assert.deepEqual(await errors("git delete branch old"), ["A branch name is text, in quotes: git delete branch 'old'"]);
  assert.deepEqual(await errors("git rebase onto main"), ["A branch name is text, in quotes: git rebase onto 'main'"]);
  // a variable that holds the name still works
  await output("set target to 'main'\ngit switch to target");
});

// ----- stash, restore, pull, blame and tag: each test has its own repo -----

async function repo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clank-gitmore-"));
  const g = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir } });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@t"]);
  g(["config", "user.name", "t"]);
  await fs.writeFile(path.join(dir, "a.txt"), "one\n");
  await fs.writeFile(path.join(dir, ".env"), "TOKEN=x\n");
  g(["add", "a.txt", ".env"]);
  g(["commit", "-q", "-m", "first"]);
  return { dir, g, go: (source, options = {}) => run(source, { root: dir, ...options }) };
}

test("git stash keeps untracked files; stash pop brings the changes back", async () => {
  const { dir, go } = await repo();
  try {
    await fs.writeFile(path.join(dir, "a.txt"), "changed\n");
    await fs.writeFile(path.join(dir, "new.txt"), "untracked\n");
    assert.deepEqual((await go("git stash\ngit stashes")).output[0].trim().split("\n").length, 1);
    assert.equal(await fs.readFile(path.join(dir, "a.txt"), "utf8"), "one\n");
    assert.equal(await fs.readFile(path.join(dir, "new.txt"), "utf8"), "untracked\n");
    assert.deepEqual((await go("git stash pop")).errors, []);
    assert.equal(await fs.readFile(path.join(dir, "a.txt"), "utf8"), "changed\n");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("git restore puts files back, with the checks of a write, and undo takes it back", async () => {
  const { dir, go } = await repo();
  try {
    await fs.writeFile(path.join(dir, "a.txt"), "changed\n");
    const audit = { scripts: 0, records: [] };
    assert.deepEqual((await go("git restore ./a.txt", { audit })).errors, []);
    assert.equal(await fs.readFile(path.join(dir, "a.txt"), "utf8"), "one\n");
    assert.ok(audit.records.some((record) => record.kind === "git" && record.target === "restore a.txt"));
    assert.ok(audit.records.some((record) => record.kind === "restore" && record.details === "put back as in the last commit"));
    // undo brings the change back
    const undo = [];
    await fs.writeFile(path.join(dir, "a.txt"), "changed again\n");
    assert.deepEqual((await go("git restore ./a.txt", { undo })).errors, []);
    assert.deepEqual((await go("undo", { undo })).errors, []);
    assert.equal(await fs.readFile(path.join(dir, "a.txt"), "utf8"), "changed again\n");
    // a hidden file is refused, as for a write
    assert.match((await go("git restore ./.env")).errors[0].message, /^A script cannot change hidden files/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("git blame reads a file, and refuses .env files", async () => {
  const { go } = await repo();
  const result = await go("git blame ./a.txt");
  assert.deepEqual(result.errors, []);
  assert.match(result.output[0], /\) one$/m);
  assert.equal((await go("git blame ./.env")).errors[0].message, "A script cannot read .env files, because they hold secrets: .env");
  assert.equal((await go("git blame ./nope.txt")).errors[0].message, "File not found: nope.txt");
});

test("git tag and git tags; a bad tag name is refused", async () => {
  const { go } = await repo();
  assert.deepEqual((await go("git tag 'v1.0'\ngit tags")).output, ["v1.0\n"]);
  assert.match((await go("git tag '-x'")).errors[0].message, /^Not a safe tag name/);
});

test("git pull is fast-forward only, and the pulled changes make the project untrusted", async () => {
  const origin = await repo();
  const clone = await fs.mkdtemp(path.join(os.tmpdir(), "clank-gitclone-"));
  const g = (args) => execFileSync("git", args, { cwd: clone, encoding: "utf8", env: { PATH: process.env.PATH, HOME: clone } });
  try {
    execFileSync("git", ["clone", "-q", origin.dir, clone]);
    g(["config", "user.email", "t@t"]);
    g(["config", "user.name", "t"]);
    await fs.writeFile(path.join(origin.dir, "a.txt"), "from someone else\n");
    origin.g(["commit", "-q", "-am", "theirs"]);
    const result = await run("git pull\nprint the session is untrusted", { root: clone });
    assert.deepEqual(result.errors, []);
    // git pull prints what it did, then the print
    assert.equal(result.output.at(-1), "true");
    assert.equal(await fs.readFile(path.join(clone, "a.txt"), "utf8"), "from someone else\n");
    // a policy that denies fetch denies pull
    const denied = await run("git pull", { root: clone, policy: { name: "p.talk", source: "policy 'p'\ndeny fetch" } });
    assert.match(denied.errors[0].message, /fetch/);
  } finally {
    await fs.rm(origin.dir, { recursive: true, force: true });
    await fs.rm(clone, { recursive: true, force: true });
  }
});

test("git pull refuses a remote inside the project", async () => {
  const { dir, g, go } = await repo();
  try {
    g(["clone", "-q", "--bare", dir, path.join(dir, "mirror.git")]);
    g(["remote", "add", "origin", "./mirror.git"]);
    assert.match((await go("git pull")).errors[0].message, /^git pull cannot use a remote inside the project/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
