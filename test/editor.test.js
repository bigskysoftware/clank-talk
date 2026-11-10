import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const dir = "editors/vscode/";
const grammar = JSON.parse(fs.readFileSync(dir + "syntaxes/clanktalk.tmLanguage.json", "utf8"));

// every match, begin and end pattern in the grammar
function patterns(node, found = []) {
  if (node === null || typeof node !== "object") {
    return found;
  }
  for (const key of ["match", "begin", "end"]) {
    if (typeof node[key] === "string") {
      found.push(node[key]);
    }
  }
  for (const value of Object.values(node)) {
    patterns(value, found);
  }
  return found;
}

function rule(name) {
  return new RegExp(grammar.repository[name].match);
}

test("the VS Code extension files parse, and point at each other", () => {
  const manifest = JSON.parse(fs.readFileSync(dir + "package.json", "utf8"));
  JSON.parse(fs.readFileSync(dir + "language-configuration.json", "utf8"));
  assert.equal(manifest.contributes.grammars[0].scopeName, grammar.scopeName);
  assert.ok(fs.existsSync(dir + manifest.contributes.grammars[0].path));
  assert.deepEqual(manifest.contributes.languages[0].filenames, ["AGENTS.talk"]);
});

test("every grammar pattern compiles", () => {
  const all = patterns(grammar);
  assert.ok(all.length > 15);
  for (const pattern of all) {
    assert.doesNotThrow(() => new RegExp(pattern), pattern);
  }
});

test("paths, urls and possessives match as the tokenizer reads them", () => {
  assert.equal("x ./src/a.js's text".match(rule("path"))[0], "./src/a.js");
  assert.equal("[@/a.md, @/b.md]".match(rule("path"))[0], "@/a.md");
  assert.equal('read ./"my file.txt"'.match(rule("path"))[0], './"my file.txt"');
  assert.equal("fetch https://x.com/a?b=1 as json".match(rule("url"))[0], "https://x.com/a?b=1");
  assert.ok(rule("possessive").test("[1]'s first"));
  assert.ok(!rule("possessive").test("say 'sun'"));
});
