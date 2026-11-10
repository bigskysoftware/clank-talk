import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run, parse } from "../src/js/clank-talk.js";
import { HELP, referenceMarkdown, syntaxSummary } from "../src/js/help.js";

let root;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "clank-help-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function agentsTalk(source) {
  return fs.writeFile(path.join(root, "AGENTS.talk"), source);
}

const TOOLS = "# Runs the tests.\n# Gives back { code, output }.\ntool run_tests\nend\n\ntool lint with file\nend";

test("every help example parses", () => {
  for (const entry of HELP) {
    for (const example of entry.examples) {
      const { errors } = parse(example, { definitions: entry.where === "AGENTS.talk" });
      assert.deepEqual(errors, [], entry.name + ": " + example);
    }
  }
});

test("help lists commands, expressions and tools", async () => {
  await agentsTalk(TOOLS);
  const text = (await run("help", { root })).output[0];
  assert.match(text, /^Commands:\n  print +Output a value to the agent\./);
  assert.match(text, /\nExpressions:\n/);
  assert.match(text, /\n  run_tests +Runs the tests\.\n  lint with file *\n/);
});

test("help <word> shows syntax, description and examples", async () => {
  const text = (await run("help replace", { root })).output[0];
  assert.match(text, /^replace <old> with <new> in <file or variable>/);
  assert.match(text, /Examples:\n\n  replace 'var ' with 'let ' in \.\/src\/app\.js/);
});

test("help for a tool shows the comment above it", async () => {
  await agentsTalk(TOOLS);
  const text = (await run("help run_tests", { root })).output[0];
  assert.equal(text, "run_tests\nA tool. Call it by name, with arguments by position or with name: value.\n\nRuns the tests.\nGives back { code, output }.");
});

test("help with two words, and help for one group", async () => {
  assert.match((await run("help on error", { root })).output[0], /^on error \.\.\. \[continue \| stop\] end/);
  const commands = (await run("help commands", { root })).output[0];
  assert.match(commands, /^Commands:/);
  assert.doesNotMatch(commands, /Expressions:/);
  assert.match((await run("help tools", { root })).output[0], /^Tools: none/);
});

test("help for an unknown word is an error", async () => {
  const result = await run("help banana", { root });
  assert.equal(result.errors[0].message, "No help for 'banana'. Use help to list everything");
});

test("a word on the next line is not part of help", async () => {
  const result = await run("help\nprint 1", { root });
  assert.equal(result.output[1], "1");
});

test("help puts its text in the result too", async () => {
  const result = await run("help then\nprint the result starts with '<command> then <command>'", { root });
  assert.equal(result.output[1], "true");
});

test('the reference has every entry, with its examples', () => {
  const md = referenceMarkdown();
  for (const entry of HELP) {
    assert.ok(md.includes('### ' + entry.name + '\n'), entry.name);
    for (const example of entry.examples) {
      assert.ok(md.includes('```talk\n' + example + '\n```'), entry.name);
    }
  }
  assert.ok(md.indexOf('## Commands') < md.indexOf('## Expressions'));
  assert.ok(md.indexOf('## Expressions') < md.indexOf('## AGENTS.talk'));
});

test('the syntax summary has one line for each entry', () => {
  const summary = syntaxSummary();
  for (const entry of HELP) {
    assert.ok(summary.includes('  ' + entry.syntax + '   '), entry.name);
  }
});
