import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run, parse } from "../src/js/clank-talk.js";
import { HELP, RECIPES, AREAS, referenceMarkdown, agentsTalkReferenceMarkdown, syntaxSummary, helpFor } from "../src/js/help.js";

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
      const { errors } = parse(example, { definitions: entry.where === "AGENTS.talk", tools: ["run_tests", "dev_server"] });
      assert.deepEqual(errors, [], entry.name + ": " + example);
    }
  }
});

test("help starts with examples that run, then the tools; help commands lists everything", async () => {
  await agentsTalk(TOOLS);
  const text = (await run("help", { root })).output[0];
  assert.match(text, /^ClankTalk is a simple scripting language for you to use\./);
  assert.match(text, /\n# This lists the files in the root of a project\. @\/ is the project root\.\nlist @\/\n/);
  assert.match(text, /\nTools in this project:\n  run_tests +Runs the tests\.\n  lint with file *\n/);
  const all = (await run("help commands", { root })).output[0];
  assert.match(all, /^Commands:\n  print +Output a value to the agent\./);
});

test("help <word> shows syntax, description and examples", async () => {
  const text = (await run("help replace", { root })).output[0];
  assert.match(text, /^replace \[every\] <old> with <new> in <file, files, glob or variable>/);
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
  assert.match((await run("help tools", { root })).output[0], /^Tools in this project: none/);
});

test("help for an unknown word is an error", async () => {
  const result = await run("help banana", { root });
  assert.equal(result.errors[0].message, "No help for 'banana'. Use help to list everything");
});

test("bare help maps the levels and every area", async () => {
  const text = (await run("help", { root })).output[0];
  assert.match(text, /\nHow to use help:\n  help <area> /);
  for (const area of AREAS) {
    assert.ok(text.includes("\n  help " + area.key + " "), area.key);
  }
});

test("help <area> shows each command of the area with its form and one example, and the next level", async () => {
  const text = (await run("help files", { root })).output[0];
  assert.match(text, /^Files: Read, find, change/);
  assert.ok(text.includes("\nread <file>\n  Put the text of a file in the result.\n    "));
  assert.match(text, /For all forms and examples of one command: help <command>, for example help list\. All areas: help$/);
  assert.match((await run("help control flow", { root })).output[0], /^Control Flow: /);
  assert.match((await run("help hooks", { root })).output[0], /^Hooks and Rules: Only in AGENTS\.talk/);
  const tools = (await run("help tools", { root })).output[0];
  assert.match(tools, /^Tools in this project: none\. A human can add tools in AGENTS\.talk\.\n[\s\S]*\nTools: Only in AGENTS\.talk/);
  assert.match((await run("help git", { root })).output[0], /^git status/);
});

test("help <command> names its area", async () => {
  assert.match((await run("help read", { root })).output[0], /\n\nMore in this area: help files$/);
});

test("help knows other words that agents try", async () => {
  assert.match((await run("help loops", { root })).output[0], /^Control Flow: /);
  assert.match((await run("help regex", { root })).output[0], /^pattern /);
  assert.match((await run("help split", { root })).output[0], /^lines of /);
});

test("help for a word close to a topic names the closest topics", async () => {
  const result = await run("help raed", { root });
  assert.match(result.errors[0].message, /^No help for 'raed'\. Did you mean: help read[,?]/);
});

test("every help example is an ideal pattern: no parentheses for grouping, no paths in quotes", () => {
  for (const entry of HELP) {
    for (const example of entry.examples) {
      const code = example.replace(/^\s*\|.*$/gm, "").replace(/'[^'\n]*'|"[^"\n]*"/g, "''").replace(/pattern \/.*\//g, "pattern //");
      if (entry.name !== "operators") {
        assert.doesNotMatch(code, /\(/, entry.name + ": " + example);
      }
      assert.doesNotMatch(example, /['"](@\/|\.\.?\/)/, entry.name + ": " + example);
      if (entry.name !== "help") {
        assert.doesNotMatch(example, /^help /, entry.name + ": an example shows a use, not help");
      }
    }
  }
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
  assert.ok(md.indexOf('id="basics"') < md.indexOf('id="files"'));
  assert.ok(md.includes('`help <word>` shows one entry'));
});

test('the AGENTS.talk reference has every AGENTS.talk entry, and the table of hook steps', () => {
  const md = agentsTalkReferenceMarkdown();
  for (const entry of HELP.filter((item) => item.where === 'AGENTS.talk')) {
    assert.ok(md.includes('### ' + entry.name + '\n'), entry.name);
  }
  assert.ok(md.includes('| `run` | program, args, sandbox, secrets |'));
});

test('each help entry is in exactly one area of the reference', () => {
  const names = AREAS.flatMap((area) => area.names);
  assert.deepEqual([...names].sort(), HELP.map((entry) => entry.name).sort());
});

test('the syntax summary has one line for each entry', () => {
  const summary = syntaxSummary();
  for (const entry of HELP) {
    assert.ok(summary.includes('  ' + entry.syntax + '   '), entry.name);
  }
});

test('every recipe parses, and shows in help recipes and the reference', async () => {
  const text = helpFor('recipes', []);
  const md = referenceMarkdown();
  assert.ok(RECIPES.length >= 5);
  for (const recipe of RECIPES) {
    const { errors } = parse(recipe.example, { tools: ['run_tests', 'dev_server'] });
    assert.deepEqual(errors, [], recipe.name);
    assert.ok(text.includes(recipe.name), recipe.name);
    assert.ok(md.includes('```talk\n' + recipe.example + '\n```'), recipe.name);
  }
  const result = await run('help recipes');
  assert.match(result.output[0], /^Recipes: common tasks, step by step\./);
});
