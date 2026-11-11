import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { VERSION } from "../src/js/clank-talk.js";
import { helpFor } from "../src/js/help.js";

test("the version comes from package.json", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(VERSION, pkg.version);
});

test("help keeping shows the run entry", () => {
  assert.match(helpFor("keeping", []), /^run <program and args>/);
});

test("a tool summary is the comment up to its first full sentence", async () => {
  const { toolSummary } = await import("../src/js/help.js");
  assert.equal(toolSummary("Packs the package, and runs the CLI and the\nMCP server from it. It publishes nothing."), "Packs the package, and runs the CLI and the MCP server from it. It publishes nothing.");
  assert.equal(toolSummary("Starts the site.\nStop it with: stop process 'site'"), "Starts the site.");
  assert.equal(toolSummary(""), "");
});
