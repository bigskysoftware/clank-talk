import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parse } from "../src/js/clank-talk.js";

// every ```talk example in the docs must parse
// an example that starts with "# AGENTS.talk" parses as AGENTS.talk
// other examples know the tools that the docs define
const TOOLS = ["run_tests", "run_test", "site_server"];

// a block is ```talk, or ```talk <title>; a block titled AGENTS.talk parses as AGENTS.talk too
test("every docs example parses", () => {
  let count = 0;
  for (const file of ["docs/docs.md", "docs/index.md"]) {
    const docs = fs.readFileSync(file, "utf8");
    for (const block of docs.match(/```talk[^\n]*\n[\s\S]*?```/g)) {
      const firstLine = block.slice(0, block.indexOf("\n"));
      const title = firstLine.slice("```talk".length).trim();
      const code = block.slice(firstLine.length + 1, -3);
      const definitions = code.startsWith("# AGENTS.talk") || title === "AGENTS.talk";
      const { errors } = parse(code, { definitions, tools: TOOLS });
      assert.deepEqual(errors, [], file + ": " + code);
      count++;
    }
  }
  assert.ok(count > 30);
});
