import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "../src/js/clank-talk.js";

let root;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "clank-agents-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function agentsTalk(source) {
  return fs.writeFile(path.join(root, "AGENTS.talk"), source);
}

async function output(source, options = {}) {
  const result = await run(source, { root, ...options });
  assert.deepEqual(result.errors, []);
  return result.output;
}

async function errors(source, options = {}) {
  const result = await run(source, { root, ...options });
  return result.errors;
}

test("no AGENTS.talk is fine", async () => {
  assert.deepEqual(await output("print 1"), ["1"]);
});

test("a tool with no arguments", async () => {
  await agentsTalk("tool greet\n  set the result to 'hi'\nend");
  assert.deepEqual(await output("greet\nprint the result"), ["hi"]);
});

test("arguments by position", async () => {
  await agentsTalk("tool add with a, b\n  set the result to a + b\nend");
  assert.deepEqual(await output("add 1, 2\nprint it"), ["3"]);
});

test("arguments by name", async () => {
  await agentsTalk("tool deploy with env, version\n  set the result to '${env}@${version}'\nend");
  assert.deepEqual(await output("deploy with version: '1.2', env: 'prod'\nprint it"), ["prod@1.2"]);
});

test("a tool call is also a value, and leaves the result as it was", async () => {
  await agentsTalk("tool greet\n  set the result to 'hi'\nend\ntool add with a, b\n  set the result to a + b\nend\ntool deploy with env, version\n  set the result to '${env}@${version}'\nend");
  assert.deepEqual(await output("set g to greet\nprint g"), ["hi"]);
  assert.deepEqual(await output("set sum to add 1, 2\nprint sum"), ["3"]);
  assert.deepEqual(await output("set the result to 'before'\nset d to deploy with env: 'prod', version: '1.2'\nprint d\nprint the result"), ["prod@1.2", "before"]);
});

test("a missing argument is null", async () => {
  await agentsTalk("tool show with a, b\n  set the result to b\nend");
  assert.deepEqual(await output("show 1\nprint it"), ["null"]);
});

test("too many arguments is an error", async () => {
  await agentsTalk("tool one with a\nend");
  const [e] = await errors("one 1, 2");
  assert.equal(e.message, "Tool 'one' takes 1 arguments, found 2");
});

test("an unknown argument name is an error", async () => {
  await agentsTalk("tool one with a\nend");
  const [e] = await errors("one with b: 1");
  assert.equal(e.message, "Tool 'one' has no argument named 'b'");
});

test("a tool has its own local variables", async () => {
  await agentsTalk("tool inner\n  set x to 'inside'\nend");
  assert.deepEqual(await output("set x to 'outside'\ninner\nprint x"), ["outside"]);
});

test("globals are shared with tools", async () => {
  await agentsTalk("tool bump\n  increment $count\nend");
  assert.deepEqual(await output("bump bump\nprint $count"), ["2"]);
});

test("the caller's result comes back from the tool, not the caller's old one", async () => {
  await agentsTalk("tool nothing\nend");
  assert.deepEqual(await output("set the result to 5\nnothing\nprint it"), ["null"]);
});

test("tools can call tools", async () => {
  await agentsTalk("tool a\n  b\n  set the result to 'a then ' + it\nend\ntool b\n  set the result to 'b'\nend");
  assert.deepEqual(await output("a\nprint it"), ["a then b"]);
});

test("a tool that calls itself stops at the step budget", async () => {
  await agentsTalk("tool loop\n  loop\nend");
  const [e] = await errors("loop", { maxSteps: 20 });
  assert.equal(e.message, "Step budget of 20 used up");
});

test("errors inside a tool point into AGENTS.talk", async () => {
  await agentsTalk("tool bad\n  print 1 / 0\nend");
  const [e] = await errors("bad");
  assert.deepEqual(e, { message: "Division by zero", line: 2, column: 11, file: "AGENTS.talk" });
});

test("parse errors in AGENTS.talk say so", async () => {
  await agentsTalk("tool bad\n  print\nend");
  const [e] = await errors("print 1");
  assert.equal(e.file, "AGENTS.talk");
});

test("only definitions are allowed in AGENTS.talk", async () => {
  await agentsTalk("print 1\ntool ok\nend");
  const [e] = await errors("print 1");
  assert.deepEqual(e, { message: "Only definitions are allowed here, such as 'tool'", line: 1, column: 1, file: "AGENTS.talk" });
});

test("a tool defined twice is an error", async () => {
  await agentsTalk("tool a\nend\ntool a\nend");
  const [e] = await errors("print 1");
  assert.equal(e.message, "Tool 'a' is defined twice");
});

test("a name used by AGENTS.talk and the host is an error", async () => {
  await agentsTalk("tool a\nend");
  const [e] = await errors("print 1", { tools: { a: async () => 1 } });
  assert.equal(e.message, "Tool 'a' is also a host tool");
});

test("host tools get their arguments", async () => {
  const tools = { echo: async ({ args, named }) => args.concat(named.extra || []) };
  assert.deepEqual(await output("echo 1, 2\nprint it\necho with extra: 3\nprint it", { tools }), ["[1,2]", "[3]"]);
});

test("a script can read AGENTS.talk, but not change it", async () => {
  await agentsTalk("tool a\nend");
  assert.deepEqual(await output("print @/AGENTS.talk contains 'tool a'"), ["true"]);
  const [w] = await errors("write 'x' to @/AGENTS.talk");
  assert.match(w.message, /^A script cannot change .talk files/);
  const [r] = await errors("replace 'a' with 'b' in @/AGENTS.talk");
  assert.match(r.message, /^A script cannot change .talk files/);
});

test("AGENTS.talk cannot be changed through another name", async () => {
  await agentsTalk("tool a\nend");
  await fs.link(path.join(root, "AGENTS.talk"), path.join(root, "hard.talk"));
  const [hard] = await errors("append 'x' to ./hard.talk");
  assert.match(hard.message, /^A script cannot change .talk files/);
  const [lower] = await errors("write 'x' to ./agents.talk");
  assert.match(lower.message, /^A script cannot change .talk files/);
});

test("a script cannot make AGENTS.talk when there is none", async () => {
  const [e] = await errors("write 'tool x\\nend' to @/AGENTS.talk");
  assert.match(e.message, /^A script cannot change .talk files/);
});

test("a positional argument can be on the next line", async () => {
  await agentsTalk("tool show with a\n  set the result to a\nend");
  assert.deepEqual(await output("show\n  'x'\nprint it"), ["x"]);
});

test("a script cannot change any .talk file, or the talk folder", async () => {
  await fs.mkdir(path.join(root, "talk"));
  await fs.writeFile(path.join(root, "talk", "plugin.js"), "x");
  for (const source of [
    "write 'x' to ./tools.talk",
    "write 'x' to ./sub/Other.TALK",
    "write 'x' to @/talk/plugin.js",
    "write 'x' to @/talk/new.js",
    "write 'x' to @/Talk/new.js",
  ]) {
    const [e] = await errors(source);
    assert.match(e.message, /^A script cannot change .talk files/, source);
  }
});

test("a symlink to a .talk file or into the talk folder is refused", async () => {
  await fs.mkdir(path.join(root, "talk"));
  await fs.writeFile(path.join(root, "talk", "plugin.js"), "x");
  await fs.writeFile(path.join(root, "tools.talk"), "tool a\nend");
  await fs.symlink(path.join(root, "tools.talk"), path.join(root, "innocent.txt"));
  await fs.symlink(path.join(root, "talk"), path.join(root, "lib"));
  const [a] = await errors("write 'x' to ./innocent.txt");
  assert.match(a.message, /^A script cannot change .talk files/);
  const [b] = await errors("write 'x' to ./lib/plugin.js");
  assert.match(b.message, /^A script cannot change .talk files/);
});

test("a script can still read .talk files and the talk folder", async () => {
  await fs.mkdir(path.join(root, "talk"));
  await fs.writeFile(path.join(root, "talk", "plugin.js"), "hello");
  assert.deepEqual(await output("print read @/talk/plugin.js"), ["hello"]);
});

test('on error in a tool covers the tool, and the caller can handle a tool that stops', async () => {
  await agentsTalk(`tool bad\n  print 1 / 0\n  on error\n    print 'tool saw it'\n  end\nend`);
  assert.deepEqual(await output(`bad\nprint 'after'\non error\n  print 'caller saw it'\n  continue\nend`), ['tool saw it', 'caller saw it', 'after']);
});

test('import loads tools from another .talk file', async () => {
  await fs.mkdir(path.join(root, 'talk'));
  await fs.writeFile(path.join(root, 'talk', 'greet.talk'), "# Says hi.\ntool greet with name\n  set the result to 'hi ' + name\nend");
  await agentsTalk('import ./talk/greet.talk');
  assert.deepEqual(await output("greet 'bob'\nprint it"), ['hi bob']);
});

test('import paths start from the importing file', async () => {
  await fs.mkdir(path.join(root, 'talk'));
  await fs.writeFile(path.join(root, 'talk', 'all.talk'), 'import ./greet.talk');
  await fs.writeFile(path.join(root, 'talk', 'greet.talk'), "tool greet\n  set the result to 'hi'\nend");
  await agentsTalk('import ./talk/all.talk');
  assert.deepEqual(await output('greet\nprint it'), ['hi']);
});

test('tools from different files can call each other', async () => {
  await fs.writeFile(path.join(root, 'inner.talk'), "tool inner\n  set the result to 'in'\nend");
  await agentsTalk('import ./inner.talk\ntool outer\n  inner\nend');
  assert.deepEqual(await output('outer\nprint it'), ['in']);
});

test('errors in an imported tool point at its file', async () => {
  await fs.writeFile(path.join(root, 'bad.talk'), 'tool bad\n  print 1 / 0\nend');
  await agentsTalk('import ./bad.talk');
  const [e] = await errors('bad');
  assert.deepEqual(e, { message: 'Division by zero', line: 2, column: 11, file: 'bad.talk' });
});

test('a file imported two times loads once', async () => {
  await fs.writeFile(path.join(root, 'a.talk'), 'tool x\nend');
  await fs.writeFile(path.join(root, 'b.talk'), 'import ./a.talk');
  await agentsTalk('import ./a.talk\nimport ./b.talk');
  assert.deepEqual(await output('x\nprint 1'), ['1']);
});

test('import errors', async () => {
  const cases = [
    ['import ./x.js', 'Cannot import ./x.js: only .talk files can be imported'],
    ['import ./nope.talk', 'Cannot import ./nope.talk: file not found'],
    ['import ../x.talk', 'Cannot import ../x.talk: it is outside the project root'],
    ['import x', "Expected a path after 'import', such as ./talk/git.talk"],
  ];
  for (const [source, message] of cases) {
    await agentsTalk(source);
    const [e] = await errors('print 1');
    assert.equal(e.message, message, source);
  }
});

test('an import loop is an error', async () => {
  await fs.writeFile(path.join(root, 'a.talk'), 'import @/AGENTS.talk');
  await agentsTalk('import ./a.talk');
  const [e] = await errors('print 1');
  assert.deepEqual(e, { message: 'Import loop: AGENTS.talk -> a.talk -> AGENTS.talk', line: 1, column: 1, file: 'a.talk' });
});

test('allow env is only allowed in AGENTS.talk', async () => {
  await fs.writeFile(path.join(root, 'a.talk'), 'allow env SECRET');
  await agentsTalk('import ./a.talk');
  const [e] = await errors('print 1');
  assert.deepEqual(e, { message: "'allow env' is only allowed in AGENTS.talk", line: 1, column: 1, file: 'a.talk' });
});

test('scripts cannot import', async () => {
  const [e] = await errors('import ./a.talk');
  assert.equal(e.message, "Unknown command 'import'");
});
