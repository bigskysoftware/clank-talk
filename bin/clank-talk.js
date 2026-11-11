#!/usr/bin/env node
// The human's command line: clank-talk taint [command] [--root <dir>]; see src/js/taint-cli.js
import { taintCommand, USAGE } from "../src/js/taint-cli.js";
import { projectRoot } from "../src/js/host.js";

const args = process.argv.slice(2);
let given = null;
const at = args.indexOf("--root");
if (at !== -1) {
  given = args[at + 1];
  args.splice(at, 2);
}

if (args[0] !== "taint") {
  console.log(USAGE);
  process.exit(args.length === 0 || args[0] === "--help" ? 0 : 1);
}
process.exitCode = await taintCommand(args.slice(1), projectRoot(given, process.cwd()), (line) => console.log(line));
