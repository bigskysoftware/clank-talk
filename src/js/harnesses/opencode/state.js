// ClankTalk on or off for one opencode session: the TUI part writes it with /clank-talk, the server part reads it
// see src/md/infrastructure/opencode.md

import fs from "node:fs/promises";
import nodePath from "node:path";

// a session id that is a plain name, so it cannot point outside .talk/harness/
export const SESSION_NAME = /^[A-Za-z0-9._-]+$/;

// the state file of one session
export function statePath(root, sessionID) {
  return nodePath.join(root, ".talk", "harness", "opencode-" + sessionID + ".json");
}

// on or off for one session, and why: require clank-talk wins, then the session's file, then on when there is an AGENTS.talk
export async function sessionMode(root, sessionID, harness) {
  if (harness.required) {
    return { on: true, why: "required by AGENTS.talk" };
  }
  if (typeof sessionID === "string" && SESSION_NAME.test(sessionID)) {
    try {
      const on = JSON.parse(await fs.readFile(statePath(root, sessionID), "utf8")).on === true;
      return { on, why: "from /clank-talk " + (on ? "on" : "off") };
    } catch {
      // no file: the default
    }
  }
  return harness.agentsTalk ? { on: true, why: "the project has an AGENTS.talk" } : { on: false, why: "the project has no AGENTS.talk" };
}