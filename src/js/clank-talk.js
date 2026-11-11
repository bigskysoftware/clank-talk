// ClankTalk runtime entry point

import { readFileSync } from "node:fs";

/** The current version of ClankTalk, from package.json, so the two never differ. */
export const VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

export { run, start, listTools, stopAllProcesses } from "./runtime.js";
export { parse } from "./parser.js";
