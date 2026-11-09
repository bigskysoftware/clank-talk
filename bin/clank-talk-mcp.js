#!/usr/bin/env node
// Start the ClankTalk MCP server: clank-talk-mcp [--root <dir>] [--log <file>]
import { main } from "../src/js/mcp.js";

main(process.argv.slice(2));
