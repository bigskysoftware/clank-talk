#!/usr/bin/env node
// The human's command line: clank-talk taint [command] [--root <dir>]; see src/js/taint-cli.js
// clank-talk harness --json: the project's settings for a harness plugin; see src/md/features/harness-tools.md
import { taintCommand, USAGE } from "../src/js/taint-cli.js";
import { projectRoot } from "../src/js/host.js";
import { projectHarness } from "../src/js/runtime.js";

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
if (args[0] !== "taint") {
  console.log(USAGE);
  process.exit(args.length === 0 || args[0] === "--help" ? 0 : 1);
}
process.exitCode = await taintCommand(args.slice(1), projectRoot(given, process.cwd()), (line) => console.log(line));
