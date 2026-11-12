#!/usr/bin/env node
// The human's command line: clank-talk taint [command] [--root <dir>]; see src/js/taint-cli.js
// clank-talk harness --json: the project's settings for a harness plugin; see src/md/features/harness-tools.md
import { taintCommand, USAGE } from "../src/js/taint-cli.js";
import { projectRoot } from "../src/js/host.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { projectHarness, recordHarnessTool } from "../src/js/runtime.js";

const args = process.argv.slice(2);
let given = null;
const at = args.indexOf("--root");
if (at !== -1) {
  given = args[at + 1];
  args.splice(at, 2);
}

if (args[0] === "harness" && args[1] === "--json") {
  console.log(JSON.stringify(await projectHarness(projectRoot(given, process.cwd()))));
  process.exit(0);
}
// clank-talk status-line: for Claude Code's statusLine command, which gives JSON on stdin with session_id and the folder
// prints "clank-talk: on, untainted"; the plugin writes the session's on or off state; see src/md/features/harness-tools.md
if (args[0] === "status-line") {
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk;
  }
  let info = {};
  try {
    info = JSON.parse(text);
  } catch {
    info = {};
  }
  const folder = given || (info.workspace && info.workspace.current_dir) || info.cwd || process.cwd();
  const root = projectRoot(null, folder);
  const harness = await projectHarness(root);
  let on = harness.required || harness.agentsTalk;
  if (!harness.required && typeof info.session_id === "string" && /^[A-Za-z0-9._-]+$/.test(info.session_id)) {
    try {
      on = JSON.parse(await readFile(join(root, ".talk", "harness", "claude-code-" + info.session_id + ".json"), "utf8")).on === true;
    } catch {
      // no file for this session yet: the default from AGENTS.talk
    }
  }
  const lines = [];
  await taintCommand(["--line"], root, (line) => lines.push(line));
  console.log("clank-talk: " + (on ? "on" : "off") + ", " + lines.join(" "));
  process.exit(0);
}
// clank-talk harness record: one allowed harness tool call, as JSON on stdin { session, tool, input, output, untrusted }
if (args[0] === "harness" && args[1] === "record") {
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk;
  }
  const call = JSON.parse(text);
  const ref = await recordHarnessTool(projectRoot(given, process.cwd()), { session: String(call.session || "harness"), tool: String(call.tool), input: call.input ?? null, output: call.output ?? "", untrusted: call.untrusted === true });
  console.log(JSON.stringify({ ref }));
  process.exit(0);
}
if (args[0] !== "taint") {
  console.log(USAGE);
  process.exit(args.length === 0 || args[0] === "--help" ? 0 : 1);
}
process.exitCode = await taintCommand(args.slice(1), projectRoot(given, process.cwd()), (line) => console.log(line));
