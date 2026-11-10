import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "../src/js/clank-talk.js";

// a temporary project:
//   project/README.md
//   project/notes.txt          two lines, with a TODO
//   project/src/a.js, b.js
//   project/src/deep/c.js
//   project/escape.txt         a symlink to a file outside the project
//   outside.txt
let dir;
let root;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "clank-files-"));
  root = path.join(dir, "project");
  await fs.mkdir(path.join(root, "src", "deep"), { recursive: true });
  await fs.writeFile(path.join(root, "README.md"), "# Hello\n");
  await fs.writeFile(path.join(root, "notes.txt"), "first\nTODO: second\n");
  await fs.writeFile(path.join(root, "src", "a.js"), "var a = 1\n");
  await fs.writeFile(path.join(root, "src", "b.js"), "let b = 2\n");
  await fs.writeFile(path.join(root, "src", "deep", "c.js"), "var c = 3\n");
  await fs.writeFile(path.join(dir, "outside.txt"), "secret\n");
  await fs.symlink(path.join(dir, "outside.txt"), path.join(root, "escape.txt"));
});

after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function output(source, options = {}) {
  const result = await run(source, { root, ...options });
  assert.deepEqual(result.errors, []);
  return result.output;
}

async function errors(source, options = {}) {
  const result = await run(source, { root, ...options });
  return result.errors.map((e) => e.message);
}

test("read puts the text in the result", async () => {
  assert.deepEqual(await output("read @/README.md\nprint it"), ["# Hello\n"]);
});

test("read is also an expression", async () => {
  assert.deepEqual(await output("set readme to read @/README.md\nprint readme"), ["# Hello\n"]);
  assert.deepEqual(await output("print read ./README.md + '!'"), ["# Hello\n!"]);
});

test("file properties", async () => {
  assert.deepEqual(
    await output("set f to ./src/a.js\nprint f's name\nprint f's path\nprint f's size\nprint f's text"),
    ["a.js", "src/a.js", "10", "var a = 1\n"],
  );
});

test("modified is an ISO date", async () => {
  const [modified] = await output("print ./README.md's modified");
  assert.match(modified, /^\d{4}-\d\d-\d\dT/);
});

test("print shows a file as its path", async () => {
  assert.deepEqual(await output("print ./src/a.js"), ["src/a.js"]);
});

test("lines know their number, and are their text", async () => {
  assert.deepEqual(
    await output("for line in ./notes.txt's lines\n  print '${line.number}: ${line}'\nend"),
    ["1: first", "2: TODO: second"],
  );
});

test("text operators work on files and lines", async () => {
  assert.deepEqual(
    await output("print ./notes.txt contains 'TODO'\nprint ./src/b.js contains 'var '\nprint ./README.md starts with '#'"),
    ["true", "false", "true"],
  );
  assert.deepEqual(
    await output("for line in ./notes.txt's lines\n  if line contains 'TODO' print line.number end\nend"),
    ["2"],
  );
});

test("exists", async () => {
  assert.deepEqual(await output("print ./README.md exists\nprint ./nope.txt exists\nprint ./nope.txt does not exist"), ["true", "false", "true"]);
});

test("globs give a sorted list of files", async () => {
  assert.deepEqual(await output("for file in ./src/**/*.js\n  print file\nend"), ["src/a.js", "src/b.js", "src/deep/c.js"]);
  assert.deepEqual(await output("print ./src/*"), ['["src/a.js","src/b.js"]']);
});

test("the hero example finds the files to change", async () => {
  const source = "for file in ./src/**/*.js\n  if the file's text contains 'var '\n    print the file's path\n  end\nend";
  assert.deepEqual(await output(source), ["src/a.js", "src/deep/c.js"]);
});

test("./ is relative to cwd, @/ to the root", async () => {
  assert.deepEqual(await output("print ./a.js's path\nprint @/README.md's path", { cwd: "src" }), ["src/a.js", "README.md"]);
});

test("../ inside the root is fine", async () => {
  assert.deepEqual(await output("print ../README.md's name", { cwd: "src" }), ["README.md"]);
});

test("paths outside the root are refused", async () => {
  assert.deepEqual(await errors("print ../outside.txt"), ["Path is outside the project root: ../outside.txt"]);
  assert.deepEqual(await errors("print ../*.txt"), ["Path is outside the project root: ../outside.txt"]);
});

test("symlinks that point outside the root are refused", async () => {
  assert.deepEqual(await errors("read ./escape.txt"), ["Path is outside the project root: escape.txt"]);
});

test("a missing file is an error", async () => {
  assert.deepEqual(await errors("read ./nope.txt"), ["File not found: nope.txt"]);
});

test("reading a folder is an error", async () => {
  assert.deepEqual(await errors("read ./src"), ["Not a file: src"]);
});

test("read needs a file", async () => {
  assert.deepEqual(await errors("read 'README.md'"), ["Expected a file, found 'README.md'"]);
});

test("file objects cannot be changed or looked into", async () => {
  assert.deepEqual(await errors("set f to ./README.md\nset f's path to 'x'"), ["Cannot set 'path' on a file"]);
  assert.deepEqual(await output("set f to ./README.md\nprint f['absolute']"), ["null"]);
});

test('lines a to b of a file, by line number', async () => {
  assert.deepEqual(await output(`print lines 1 to 1 of ./notes.txt`), ['1: first']);
  assert.deepEqual(await output(`print lines 1 to 2 of ./notes.txt`), ['1: first\n2: TODO: second']);
});

test('a range past the end stops at the last line', async () => {
  assert.deepEqual(await output(`print lines 2 to 99 of ./notes.txt`), ['2: TODO: second']);
});

test('lines a to b of text', async () => {
  assert.deepEqual(await output(`set t to 'a\\nb\\nc'\nprint lines 2 to 3 of t`), ['2: b\n3: c']);
});

test('a loop over a range', async () => {
  assert.deepEqual(await output(`for line in lines 2 to 2 of ./notes.txt\n  print line.number\nend`), ['2']);
});

test('as text joins the lines, with no numbers', async () => {
  assert.deepEqual(await output(`print (lines 1 to 2 of ./notes.txt) as text`), ['first\nTODO: second']);
});

test('lines alone is still a variable', async () => {
  assert.deepEqual(await output(`set lines to 5\nprint lines`), ['5']);
});

test('range errors', async () => {
  assert.deepEqual(await errors(`print lines 1 to 2 of 5`), ['Expected a file or text, found 5']);
  assert.deepEqual((await errors(`print lines 1 to 2 ./notes.txt`))[0], `Expected 'of'`);
});

test("first and last of a file are lines", async () => {
  assert.deepEqual(await output("print first of ./notes.txt\nprint the number of the last of ./notes.txt\nprint ./notes.txt's last"), ["first", "2", "TODO: second"]);
});

test('a list of paths, and possessives after a list or object', async () => {
  assert.deepEqual(await output(`print [./notes.txt, ./README.md]'s last\nprint {a: 1}'s a\nprint (first of ./notes.txt)'s number`), ['README.md', '1', '1']);
});

test('find gives the lines that contain the text, and print shows path:number', async () => {
  assert.deepEqual(await output(`find 'var' in ./src/**/*.js\nprint the result`), ['src/a.js:1: var a = 1\nsrc/deep/c.js:1: var c = 3']);
  assert.deepEqual(await output(`find 'TODO' in ./notes.txt\nprint the result's first's number\nprint the result's first's file`), ['2', 'notes.txt']);
  assert.deepEqual(await output(`find 'b' in 'abc\\nxyz\\nb'\nprint the result`), ['1: abc\n3: b']);
  assert.deepEqual(await output(`find 'nope' in ./notes.txt\nprint the result is empty`), ['true']);
});

test('find errors', async () => {
  assert.deepEqual(await errors(`find '' in ./notes.txt`), ['Cannot find empty text']);
  assert.deepEqual(await errors(`find 'x' in 5`), ["'find' needs a file, a list of files, or text, found 5"]);
  assert.deepEqual((await errors(`find 'x' ./notes.txt`))[0], "Expected 'in'");
});

test('a glob skips node_modules and .git, unless the pattern names them', async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "clank-skip-"));
  await fs.mkdir(path.join(project, "node_modules", "lib"), { recursive: true });
  await fs.mkdir(path.join(project, ".git"));
  await fs.writeFile(path.join(project, "a.js"), "");
  await fs.writeFile(path.join(project, "node_modules", "lib", "b.js"), "");
  await fs.writeFile(path.join(project, ".git", "c.js"), "");
  try {
    assert.deepEqual(await output(`print ./**/*.js`, { root: project }), ['["a.js"]']);
    assert.deepEqual(await output(`print ./node_modules/**/*.js`, { root: project }), ['["node_modules/lib/b.js"]']);
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});

test("a glob leaves out links that point to nothing or outside the root", async () => {
  await fs.symlink(path.join(root, "nothere.txt"), path.join(root, "dangle.txt"));
  await fs.writeFile(path.join(dir, "secret.txt"), "s");
  await fs.symlink(path.join(dir, "secret.txt"), path.join(root, "out.txt"));
  try {
    const result = await run("print ./*.txt", { root });
    assert.deepEqual(result.errors, []);
    assert.ok(!result.output.join("\n").includes("dangle.txt"), result.output.join("\n"));
    assert.ok(!result.output.join("\n").includes("out.txt"), result.output.join("\n"));
  } finally {
    await fs.rm(path.join(root, "dangle.txt"));
    await fs.rm(path.join(root, "out.txt"));
    await fs.rm(path.join(dir, "secret.txt"));
  }
});

test("exists is false for a link to outside the root, whether the file is there or not", async () => {
  await fs.symlink(path.join(dir, "no-such-file.txt"), path.join(root, "gone.txt"));
  try {
    const result = await run("print ./escape.txt exists\nprint ./gone.txt exists", { root });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.output, ["false", "false"]);
  } finally {
    await fs.rm(path.join(root, "gone.txt"));
  }
});

test("line n of a file or text: one line, and an error past the end", async () => {
  assert.deepEqual(await output("print line 2 of ./notes.txt"), ["TODO: second"]);
  assert.deepEqual(await output("set n to 1\nset first to line n of ./notes.txt\nprint first's text"), ["first"]);
  assert.deepEqual(await output("read ./notes.txt\nset first to line 1 of the result\nprint first's number"), ["1"]);
  assert.deepEqual(await output("for line in lines of ./notes.txt\n  print line's number\nend"), ["1", "2"]);
  const result = await run("print line 3 of ./notes.txt", { root });
  assert.deepEqual(result.errors.map((e) => e.message), ["Line 3 is past the end of notes.txt (2 lines)"]);
  const zero = await run("print line 0 of 'a'", { root });
  assert.deepEqual(zero.errors.map((e) => e.message), ["Line numbers start at 1, found 0"]);
});
