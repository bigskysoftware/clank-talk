import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "../src/js/clank-talk.js";

// edge cases that once crashed run(), leaked names or bytes, or changed the wrong text
// a fresh project for each test: dir/project is the root, dir/outside is outside it
let dir;
let root;
// one undo list for the scripts of a test, as a host keeps it
let undo;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "clank-edge-"));
  root = path.join(dir, "project");
  undo = [];
  await fs.mkdir(root);
  await fs.mkdir(path.join(dir, "outside"));
  await fs.writeFile(path.join(dir, "outside", "outside-secret-name.txt"), "s\n");
});

afterEach(async () => {
  await fs.chmod(path.join(root, "ro"), 0o755).catch(() => {});
  await fs.rm(dir, { recursive: true, force: true });
});

async function output(source) {
  const result = await run(source, { root, undo });
  assert.deepEqual(result.errors, []);
  return result.output;
}

async function errors(source) {
  const result = await run(source, { root, undo });
  return result.errors.map((e) => e.message);
}

function project(name) {
  return path.join(root, name);
}

// chmod has no effect for root, so the permission tests skip there
const isRoot = process.getuid !== undefined && process.getuid() === 0;

// ----- parse -----

test("deep not, minus, of and ${} give the nesting error, not a crash", async () => {
  const deep = [
    "print " + "-".repeat(5000) + "1",
    "print " + "not ".repeat(5000) + "true",
    "print " + "a of ".repeat(5000) + "x",
    "print " + "'${".repeat(3000) + "1" + "}'".repeat(3000),
  ];
  for (const source of deep) {
    assert.match((await errors(source))[0], /nests more than 100 levels deep/, source.slice(0, 12));
  }
});

test("a very long chain is a parse error, and a long one still runs", async () => {
  assert.match((await errors("print " + "1 + ".repeat(20000) + "1"))[0], /more than 500 parts in a row/);
  assert.match((await errors("set x to {}\nprint x" + "'s a".repeat(20000)))[0], /more than 500 parts in a row/);
  assert.deepEqual(await output("print " + "1 + ".repeat(400) + "1"), ["401"]);
});

test("an error in a ${} inside a ${} points at the string", async () => {
  const result = await run("print 1\nprint 'a ${'b ${1 2}'}'", { root });
  assert.deepEqual(result.errors, [{ message: "Unexpected '2' in ${}", line: 2, column: 7 }]);
});

test("an emoji outside a string is one error that names it", async () => {
  assert.deepEqual(await errors("print 1 😀"), ["Unexpected character '😀'"]);
});

test("a number too large for JavaScript is a parse error, not Infinity", async () => {
  assert.match((await errors("print 1" + "0".repeat(400)))[0], /^The number 1000.* is too large$/);
});

test("a named argument given twice is a parse error", async () => {
  assert.deepEqual(await errors("fetch 'https://example.com' with method: 'get', method: 'post'"), ["The argument 'method' is given twice"]);
  await fs.writeFile(project("AGENTS.talk"), "tool deploy with target\n  set the result to target\nend");
  assert.deepEqual(await errors("deploy with target: 'dev', target: 'prod'"), ["The argument 'target' is given twice"]);
});

test("a block word as a name is one clear error", async () => {
  for (const word of ["end", "then", "else"]) {
    assert.deepEqual(await errors("set " + word + " to 1"), ["'" + word + "' is a block word, so it cannot be a name. Use another name, such as 'last'"], word);
    assert.deepEqual(await errors("set the " + word + " to 1"), ["'" + word + "' is a block word, so it cannot be a name. Use another name, such as 'last'"], "the " + word);
  }
});

test("a path goes on after its quoted part", async () => {
  await fs.mkdir(project("my dir"));
  await fs.writeFile(project("my dir/a.txt"), "x\n");
  assert.deepEqual(await output("print ./\"my dir\"/a.txt\nprint ./\"my dir\"/a.txt's name"), ["my dir/a.txt", "a.txt"]);
});

// ----- values -----

test("a list index must be a whole number up to the length", async () => {
  // 100000000 once made a list so long that print killed the host
  for (const index of ["100000000", "-1", "1.5", "'foo'"]) {
    assert.match((await errors("set x to [1]\nset x[" + index + "] to 2"))[0], /^A list index must be a whole number from 0 to 1 /, index);
  }
  assert.deepEqual(await output("set x to [1]\nset x[1] to 2\nset x[0] to 0\nprint x"), ["[0,2]"]);
});

test("a list or object cannot hold itself", async () => {
  assert.match((await errors("set x to {}\nset x.a to x"))[0], /holds the list or object that it goes into/);
  assert.match((await errors("set x to []\nset y to {l: x}\nset x[0] to y"))[0], /holds the list or object that it goes into/);
  // the same value in two places is fine
  assert.deepEqual(await output("set a to [1]\nset x to {}\nset x.p to a\nset x.q to a\nprint x's q"), ["[1]"]);
});

test("math that grows too large is an error, not Infinity or NaN", async () => {
  assert.deepEqual(await errors("set x to 1\nrepeat 400 times\n  set x to x * 10\nend"), ["The result is too large to be a number"]);
  assert.equal((await errors("print 'Infinity' as number")).length, 1);
  assert.deepEqual(await output("print ' 12 ' as number + 1"), ["13"]);
});

test("no text contains, starts with or ends with null", async () => {
  assert.deepEqual(await output("print 'xnullx' contains null\nprint 'null' starts with null\nprint 'null' ends with null\nprint null starts with 'n'"), ["false", "false", "false", "false"]);
});

test("null is an error where it would leave as the text null", async () => {
  assert.deepEqual(await errors("write null to ./n.txt"), ["The text to write is null. To make an empty file, write ''"]);
  assert.deepEqual(await errors("set t to 'aXb'\nreplace 'X' with null in t"), ["The new text is null. To take the match away, replace it with ''"]);
  assert.deepEqual(await errors("set t to 'a null b'\nreplace null with 'x' in t"), ["The old text is null. Give it a value"]);
  assert.deepEqual(await errors("ask null with 'yes' or 'no'"), ["The question is null. Give it a value"]);
  assert.deepEqual(await errors("ask 'Go?' with null or 'no'"), ["A choice is null. Give it a value"]);
  assert.deepEqual(await errors("set b to null\ngit switch to new branch b"), ["The branch name is null. Give it a value"]);
  await assert.rejects(fs.access(project("n.txt")));
});

test("is, contains and is in compare lists and objects by their content", async () => {
  assert.deepEqual(await output("print [1, 2] is [1, 2]\nprint [[1]] contains [1]\nprint {a: [1]} is {a: [1]}\nprint {a: 1} is {a: 1, b: 2}\nprint [1, 2] is not [2, 1]"), ["true", "true", "true", "false", "true"]);
});

test("a line range starts at a whole number of 1 or more, and repeat needs a whole number", async () => {
  assert.deepEqual(await errors("print lines 0 to 1 of 'a'"), ["Line numbers start at 1, found 0"]);
  assert.deepEqual(await errors("print lines 1.5 to 2 of 'a'"), ["Line numbers start at 1, found 1.5"]);
  assert.deepEqual(await errors("print lines 1 to 2.5 of 'a'"), ["A line number must be a whole number, found 2.5"]);
  assert.deepEqual(await errors("repeat 1.5 times\n  print 1\nend"), ["repeat needs a whole number of times, found 1.5"]);
  // the end can go past the last line, and 0 or fewer times is no pass
  assert.deepEqual(await output("print lines 1 to 9 of 'a\nb'\nrepeat -1 times\n  print 1\nend"), ["1: a\n2: b"]);
});

test("an empty object is false, as an empty list is", async () => {
  assert.deepEqual(await output("if {}\n  print 'yes'\nelse\n  print 'no'\nend\nif {a: 1}\n  print 'yes'\nend"), ["no", "yes"]);
});

test("< compares numbers, and the error for text names the rule", async () => {
  assert.deepEqual(await output("print '2' < 10"), ["true"]);
  assert.deepEqual(await errors("print 'a' < 'b'"), ["A comparison such as < needs numbers, and 'a' is not a number"]);
});

// ----- files -----

test("a glob that leaves the root names the glob, not the files outside", async () => {
  for (const glob of ["@/../outside/*", "@/../out*", "@/../zzz*"]) {
    const [message] = await errors("print " + glob);
    assert.match(message, /^Path is outside the project root: /, glob);
    assert.doesNotMatch(message, /outside-secret-name/, glob);
  }
  await fs.mkdir(project("src"));
  assert.deepEqual(await errors("print ./*/../../outside/*"), ["A glob cannot have '..' after a wildcard: ./*/../../outside/*"]);
});

test("a file the system refuses is a script error with no host path, and on error can handle it", { skip: isRoot }, async () => {
  await fs.writeFile(project("locked.txt"), "x\n", { mode: 0o000 });
  const result = await run("read ./locked.txt", { root });
  assert.deepEqual(result.errors.map((e) => e.message), ["Cannot open locked.txt: permission denied (EACCES)"]);
  assert.deepEqual(await output("on error\n  print error's message\n  continue\nend\nwrite 'y' to ./locked.txt"), ["Cannot open locked.txt: permission denied (EACCES)"]);
});

test(".envrc holds secrets too, so a script cannot read it, and a glob leaves it out", async () => {
  await fs.writeFile(project(".envrc"), "export TOKEN=abc\n");
  assert.deepEqual(await errors("read ./.envrc"), ["A script cannot read .env files, because they hold secrets: .envrc"]);
  assert.deepEqual(await output("print ./.* as json"), ["[]"]);
});

test("a link to itself does not exist", async () => {
  await fs.symlink(project("self"), project("self"));
  assert.deepEqual(await output("print ./self exists"), ["false"]);
});

test("line edits keep CRLF line breaks, and the old lines have no \\r", async () => {
  await fs.writeFile(project("w.txt"), "a\r\nb\r\nc\r\n");
  assert.deepEqual(await output("read ./w.txt\nreplace lines 2 to 2 of ./w.txt with 'B'\nprint it's first's text is 'b'"), ["true"]);
  await output("read ./w.txt\nput 'top' before line 1 of ./w.txt");
  assert.equal(await fs.readFile(project("w.txt"), "utf8"), "top\r\na\r\nB\r\nc\r\n");
  // no final line break: the last line gets no \r
  await fs.writeFile(project("n.txt"), "a\r\nb");
  await output("read ./n.txt\nreplace lines 2 to 2 of ./n.txt with 'B'");
  assert.equal(await fs.readFile(project("n.txt"), "utf8"), "a\r\nB");
});

test("a BOM does not show in reads, and a write keeps it", async () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  await fs.writeFile(project("b.txt"), Buffer.concat([bom, Buffer.from("first\nsecond\n")]));
  assert.deepEqual(await output("print line 1 of ./b.txt starts with 'first'\nprint ./b.txt's text's length"), ["true", "13"]);
  await output("read ./b.txt\nreplace lines 1 to 1 of ./b.txt with 'one'");
  await output("replace 'second' with 'two' in ./b.txt");
  assert.deepEqual(await fs.readFile(project("b.txt")), Buffer.concat([bom, Buffer.from("one\ntwo\n")]));
  await output("write 'new' to ./b.txt");
  assert.deepEqual(await fs.readFile(project("b.txt")), Buffer.concat([bom, Buffer.from("new")]));
});

test("a replace that gives the same text makes no undo step", async () => {
  await fs.writeFile(project("a.txt"), "x\n");
  await output("write 'y' to ./b.txt");
  const [same] = await output("replace 'x' with 'x' in ./a.txt\nprint the result's length");
  assert.equal(same, "1");
  // undo takes back the write, not the replace
  await output("undo");
  await assert.rejects(fs.access(project("b.txt")));
});

test("a line range in the wrong order says so", async () => {
  await fs.writeFile(project("a.txt"), "a\nb\n");
  assert.deepEqual(await errors("read ./a.txt\nremove lines 2 to 1 of ./a.txt"), ["Lines 2 to 1 are in the wrong order. Write the smaller number first"]);
});

test("put adds the first line to an empty file", async () => {
  await fs.writeFile(project("e.txt"), "");
  await output("read ./e.txt\nput 'a' before line 1 of ./e.txt");
  assert.equal(await fs.readFile(project("e.txt"), "utf8"), "a\n");
  await fs.writeFile(project("e.txt"), "");
  await output("read ./e.txt\nput 'b' after line 0 of ./e.txt");
  assert.equal(await fs.readFile(project("e.txt"), "utf8"), "b\n");
  assert.deepEqual(await errors("read ./e.txt\nput 'c' after line 0 of ./e.txt"), ["Line 0 is not in e.txt, which has 1 line"]);
});

test("a file that is not UTF-8 cannot change, so its bytes are safe", async () => {
  const bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0xff, 0x00, 0x41, 0x0a]);
  await fs.writeFile(project("bin.dat"), bytes);
  assert.deepEqual(await errors("replace 'A' with 'B' in ./bin.dat"), ["A script cannot change bin.dat, because it is not UTF-8 text"]);
  assert.deepEqual(await errors("write 'x' to ./bin.dat"), ["A script cannot change bin.dat, because it is not UTF-8 text"]);
  assert.deepEqual(await fs.readFile(project("bin.dat")), bytes);
});

test("an undo that fails on one file changes no file", { skip: isRoot }, async () => {
  await fs.mkdir(project("ro"));
  await output("write 'A' to ./a.txt\nwrite 'F' to ./ro/f.txt");
  await fs.chmod(project("ro"), 0o555);
  const [message] = await errors("undo");
  assert.match(message, /^Cannot undo .*Nothing was changed$/);
  assert.equal(await fs.readFile(project("a.txt"), "utf8"), "A");
  // the step stays on the list, so undo works when the folder can change again
  await fs.chmod(project("ro"), 0o755);
  await output("undo");
  await assert.rejects(fs.access(project("a.txt")));
  await assert.rejects(fs.access(project("ro/f.txt")));
});