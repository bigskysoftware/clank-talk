import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parse } from "../src/js/clank-talk.js";

// every ```talk example in the docs must parse
// an example that starts with "# AGENTS.talk" parses as AGENTS.talk
// other examples know the tools that the docs define
const TOOLS = ["run_tests", "run_test", "site_server"];

test("every docs example parses", () => {
  const docs = fs.readFileSync("docs/docs.md", "utf8");
  const blocks = docs.match(/```talk\n[\s\S]*?```/g);
  assert.ok(blocks.length > 20);
  for (const block of blocks) {
    const code = block.slice("```talk\n".length, -3);
    const definitions = code.startsWith("# AGENTS.talk");
    const { errors } = parse(code, { definitions, tools: TOOLS });
    assert.deepEqual(errors, [], code);
  }
});
