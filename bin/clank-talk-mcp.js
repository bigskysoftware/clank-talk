#!/usr/bin/env node
// Start the ClankTalk MCP server: clank-talk-mcp [--root <dir>] [--policy <file> [--policy-hash <sha256>]]
import { main } from "../src/js/mcp.js";

main(process.argv.slice(2));
