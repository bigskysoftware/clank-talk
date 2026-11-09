import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "../src/js/clank-talk.js";

// a fresh temporary project for each test:
//   project/a.txt              "var x\nvar y\n"
//   project/linked -> outside  a symlinked folder that points outside the project
//   outside/
let dir;
let root;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "clank-write-"));
  root = path.join(dir, "project");
  await fs.mkdir(root);
  await fs.mkdir(path.join(dir, "outside"));
  await fs.writeFile(path.join(root, "a.txt"), "var x\nvar y\n");
  await fs.symlink(path.join(dir, "outside"), path.join(root, "linked"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function readProject(name) {
  return fs.readFile(path.join(root, name), "utf8");
}

async function ok(source) {
  const result = await run(source, { root });
  assert.deepEqual(result.errors, []);
  return result;
}

async function errors(source) {
  const result = await run(source, { root });
  return result.errors.map((e) => e.message);
}

test("write makes a new file", async () => {
  await ok("write 'hello' to ./out.txt");
  assert.equal(await readProject("out.txt"), "hello");
});

test("write replaces a file", async () => {
  await ok("write 'new' to ./a.txt");
  assert.equal(await readProject("a.txt"), "new");
});

test("write makes missing folders", async () => {
  await ok("write 'x' to ./new/deep/b.txt");
  assert.equal(await readProject("new/deep/b.txt"), "x");
});

test("append adds to the end, or makes the file", async () => {
  await ok("write 'hello' to ./out.txt\nappend ' world' to ./out.txt\nappend 'z' to ./z.txt");
  assert.equal(await readProject("out.txt"), "hello world");
  assert.equal(await readProject("z.txt"), "z");
});

test("objects go in as compact JSON, or pretty JSON with as pretty json", async () => {
  await ok("write {a: 1} to ./c.json\nwrite {a: 1} as pretty json to ./p.json");
  assert.equal(await readProject("c.json"), '{"a":1}');
  assert.equal(await readProject("p.json"), '{\n  "a": 1\n}');
});

test("write a file to a file copies its text", async () => {
  await ok("write ./a.txt to ./copy.txt");
  assert.equal(await readProject("copy.txt"), "var x\nvar y\n");
});

test("the JSON example from the site", async () => {
  await fs.writeFile(path.join(root, "config.json"), '{"version": 1}');
  const source = [
    "for file in ./*.json",
    "  set config to the file's text as json",
    "  if config's version is less than 2",
    "    set config's version to 2",
    "    write config as json to the file",
    "  end",
    "end",
  ].join("\n");
  await ok(source);
  assert.equal(await readProject("config.json"), '{"version":2}');
});

test("replace changes every match in a file, and lists them", async () => {
  const result = await ok("replace 'var ' with 'let ' in ./a.txt\nprint the result");
  assert.equal(await readProject("a.txt"), "let x\nlet y\n");
  assert.deepEqual(result.output, [
    '[{"line":1,"column":1,"old":"var ","new":"let "},{"line":2,"column":1,"old":"var ","new":"let "}]',
  ]);
});

test("replace with no match changes nothing, and the result is empty", async () => {
  const result = await ok("replace 'nope' with 'x' in ./a.txt\nprint the result is empty");
  assert.deepEqual(result.output, ["true"]);
  assert.deepEqual(result.changes, []);
});

test("the hero example", async () => {
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src", "a.js"), "var a = 1\n");
  await fs.writeFile(path.join(root, "src", "b.js"), "let b = 2\n");
  const source = [
    "for file in ./src/**/*.js",
    "  if the file's text contains 'var '",
    "    replace 'var ' with 'let ' in the file",
    "  end",
    "end",
  ].join("\n");
  const result = await ok(source);
  assert.equal(await readProject("src/a.js"), "let a = 1\n");
  assert.deepEqual(result.changes.map((c) => c.path), ["src/a.js"]);
});

test("replace in a variable changes the variable", async () => {
  const result = await ok("set s to 'a-b-c'\nreplace '-' with '+' in s\nprint s\nprint the result's length");
  assert.deepEqual(result.output, ["a+b+c", "2"]);
});

test("replace needs a file or a variable with text", async () => {
  assert.deepEqual(await errors("replace 'a' with 'b' in 5"), ["Expected a file, or a variable with text, found 5"]);
});

test("replace of empty text is an error", async () => {
  assert.deepEqual(await errors("replace '' with 'b' in ./a.txt"), ["Cannot replace empty text"]);
});

test("each write is recorded, with the text before and after", async () => {
  const result = await ok("write 'new' to ./a.txt\nwrite 'b' to ./b.txt");
  assert.deepEqual(result.changes, [
    { path: "a.txt", before: "var x\nvar y\n", after: "new" },
    { path: "b.txt", before: null, after: "b" },
  ]);
});

test("writes outside the root are refused", async () => {
  assert.deepEqual(await errors("write 'x' to ../evil.txt"), ["Path is outside the project root: ../evil.txt"]);
});

test("writes through a symlinked folder that leads outside are refused", async () => {
  assert.deepEqual(await errors("write 'x' to ./linked/evil.txt"), ["Path is outside the project root: linked/evil.txt"]);
  await assert.rejects(fs.stat(path.join(dir, "outside", "evil.txt")));
});

test("a list of files is not a write target", async () => {
  assert.deepEqual(await errors("write 'x' to ./*.txt"), ["Expected one file, found a list of 1. Use a for loop"]);
});

test("the hook example still parses: the write's path", async () => {
  const result = await run("set the write to {path: 'a.env'}\nprint the write's path ends with '.env'", { root });
  assert.deepEqual(result.output, ["true"]);
});

test('a write fails if the file changed after the script read it', async () => {
  const tools = { touch: async () => fs.writeFile(path.join(root, 'a.txt'), 'human edit\n') };
  const result = await run(`set t to ./a.txt's text\ntouch\nwrite 'agent edit' to ./a.txt`, { root, tools });
  assert.deepEqual(result.errors.map((e) => e.message), ['File changed since it was read: a.txt. Read it again']);
  assert.equal(await readProject('a.txt'), 'human edit\n');
});

test('replace reads the file again, so it keeps a change made before it', async () => {
  const tools = { touch: async () => fs.writeFile(path.join(root, 'a.txt'), 'var x\nhuman\n') };
  const result = await run(`set t to ./a.txt's text\ntouch\nreplace 'var' with 'let' in ./a.txt`, { root, tools });
  assert.deepEqual(result.errors, []);
  assert.equal(await readProject('a.txt'), 'let x\nhuman\n');
});

test('a write with no read before it is not checked', async () => {
  await fs.writeFile(path.join(root, 'a.txt'), 'changed\n');
  await ok(`write 'new' to ./a.txt`);
  assert.equal(await readProject('a.txt'), 'new');
});

test('a script can write the same file two times', async () => {
  await ok(`set t to ./a.txt's text\nwrite 'one' to ./a.txt\nwrite 'two' to ./a.txt`);
  assert.equal(await readProject('a.txt'), 'two');
});

test('append keeps changes made by others', async () => {
  const tools = { touch: async () => fs.writeFile(path.join(root, 'a.txt'), 'human\n') };
  const result = await run(`set t to ./a.txt's text\ntouch\nappend 'agent' to ./a.txt`, { root, tools });
  assert.deepEqual(result.errors, []);
  assert.equal(await readProject('a.txt'), 'human\nagent');
});

test('the host can keep what was read between runs', async () => {
  const seen = new Map();
  await run(`set t to ./a.txt's text`, { root, seen });
  await fs.writeFile(path.join(root, 'a.txt'), 'human edit\n');
  const result = await run(`write 'agent edit' to ./a.txt`, { root, seen });
  assert.equal(result.errors[0].message, 'File changed since it was read: a.txt. Read it again');
});

test('replace lines by number', async () => {
  const result = await ok(`read ./a.txt\nreplace lines 2 to 2 of ./a.txt with 'let y'\nprint the result`);
  assert.equal(await readProject('a.txt'), 'var x\nlet y\n');
  assert.deepEqual(result.output, ['2: var y']);
});

test('put before and after a line', async () => {
  await ok(`read ./a.txt\nput 'top' before line 1 of ./a.txt\nput 'end' after line 3 of ./a.txt`);
  assert.equal(await readProject('a.txt'), 'top\nvar x\nvar y\nend\n');
});

test('put empty text adds one empty line', async () => {
  await ok(`read ./a.txt\nput '' after line 1 of ./a.txt`);
  assert.equal(await readProject('a.txt'), 'var x\n\nvar y\n');
});

test('remove lines', async () => {
  await ok(`read ./a.txt\nremove lines 1 to 1 of ./a.txt`);
  assert.equal(await readProject('a.txt'), 'var y\n');
});

test('new text with many lines, and a final line break that does not count', async () => {
  await ok(`read ./a.txt\nreplace lines 1 to 1 of ./a.txt with 'a\\nb\\n'`);
  assert.equal(await readProject('a.txt'), 'a\nb\nvar y\n');
});

test('a line edit needs a read first', async () => {
  assert.deepEqual(await errors(`remove lines 1 to 1 of ./a.txt`), ['Read a.txt before a line edit, so the line numbers are known']);
});

test('a line edit fails if the file changed since the read', async () => {
  const tools = { touch: async () => fs.writeFile(path.join(root, 'a.txt'), 'human\nvar x\nvar y\n') };
  const result = await run(`read ./a.txt\ntouch\nremove lines 1 to 1 of ./a.txt`, { root, tools });
  assert.deepEqual(result.errors.map((e) => e.message), ['File changed since it was read: a.txt. Read it again']);
});

test('lines outside the file are an error', async () => {
  assert.deepEqual(await errors(`read ./a.txt\nremove lines 2 to 3 of ./a.txt`), ['Lines 2 to 3 are not in a.txt, which has 2 lines']);
  assert.deepEqual(await errors(`read ./a.txt\nput 'x' after line 5 of ./a.txt`), ['Line 5 is not in a.txt, which has 2 lines']);
});

test('a second line edit sees the new line numbers', async () => {
  await ok(`read ./a.txt\nput 'top' before line 1 of ./a.txt\nremove lines 3 to 3 of ./a.txt`);
  assert.equal(await readProject('a.txt'), 'top\nvar x\n');
});

test('line edits cannot change .talk files', async () => {
  await fs.writeFile(path.join(root, 'x.talk'), 'tool a\nend\n');
  const [message] = await errors(`read ./x.talk\nremove lines 1 to 1 of ./x.talk`);
  assert.match(message, /^A script cannot change .talk files/);
});

test('find reads the files, so a line edit can follow', async () => {
  await ok(`find 'var y' in ./a.txt\nset n to the result's first's number\nreplace lines n to n of ./a.txt with 'let y'`);
  assert.equal(await readProject('a.txt'), 'var x\nlet y\n');
});

test('put after line n of f, with a variable', async () => {
  await ok(`read ./a.txt\nset n to 1\nput 'mid' after line n of ./a.txt`);
  assert.equal(await readProject('a.txt'), 'var x\nmid\nvar y\n');
});

test('scripts cannot change hidden files or folders', async () => {
  for (const target of ['./.env', './.git/config', './.github/workflows/ci.yml', './src/.hidden']) {
    const [message] = await errors(`write 'x' to ${target}`);
    assert.match(message, /^A script cannot change hidden files or folders/, target);
  }
  const [message] = await errors(`append 'x' to ./.gitignore`);
  assert.match(message, /^A script cannot change hidden files or folders/);
});

test('a symlink cannot lead a write into a hidden folder', async () => {
  await fs.mkdir(path.join(root, '.git'), { recursive: true });
  await fs.writeFile(path.join(root, '.git', 'config'), '');
  await fs.symlink(path.join(root, '.git'), path.join(root, 'plain'));
  await fs.symlink(path.join(root, '.git', 'config'), path.join(root, 'config-link'));
  try {
    assert.match((await errors(`write 'x' to ./plain/hooks-pre-commit`))[0], /^A script cannot change hidden files/);
    assert.match((await errors(`write 'x' to ./config-link`))[0], /^A script cannot change hidden files/);
  } finally {
    await fs.rm(path.join(root, 'plain'));
    await fs.rm(path.join(root, 'config-link'));
    await fs.rm(path.join(root, '.git'), { recursive: true });
  }
});

test('reads of hidden files still work', async () => {
  await fs.writeFile(path.join(root, '.hidden-note'), 'hi');
  await ok(`read ./.hidden-note`);
  await fs.rm(path.join(root, '.hidden-note'));
});

test('allow changes to lets scripts change some hidden paths', async () => {
  await fs.writeFile(path.join(root, 'AGENTS.talk'), 'allow changes to @/.github/, ./.gitignore');
  try {
    await ok(`write 'x' to ./.github/workflows/ci.yml\nwrite 'y' to ./.gitignore`);
    assert.equal(await readProject('.github/workflows/ci.yml'), 'x');
    assert.match((await errors(`write 'x' to ./.env`))[0], /^A script cannot change hidden files/);
    assert.match((await errors(`write 'x' to ./.github-other`))[0], /^A script cannot change hidden files/);
  } finally {
    await fs.rm(path.join(root, 'AGENTS.talk'));
    await fs.rm(path.join(root, '.github'), { recursive: true, force: true });
    await fs.rm(path.join(root, '.gitignore'), { force: true });
  }
});

test('allow changes to: rules', async () => {
  await fs.writeFile(path.join(root, 'AGENTS.talk'), 'allow changes to ../x\nallow changes 5');
  try {
    assert.deepEqual(await errors(`print 1`), ["Expected 'to'", 'Cannot allow changes to ../x: it must be inside the project root']);
  } finally {
    await fs.rm(path.join(root, 'AGENTS.talk'));
  }
});

test('the hidden file error tells the human the line to add', async () => {
  assert.deepEqual(await errors(`write 'x' to ./.github/workflows/ci.yml`), ['A script cannot change hidden files or folders (a name that starts with .): .github/workflows/ci.yml\nTo allow this, a human can add this line to AGENTS.talk:\n  allow changes to @/.github/']);
  assert.match((await errors(`write 'x' to ./src/.cache/a`))[0], /\n  allow changes to @\/src\/.cache\/$/);
  assert.match((await errors(`write 'x' to ./.gitignore`))[0], /\n  allow changes to @\/.gitignore$/);
});
