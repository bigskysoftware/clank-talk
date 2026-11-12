// ClankTalk on or off for one opencode session: the TUI part writes it with /clank-talk, the server part reads it
// see src/md/infrastructure/opencode.md; the rule and the file are in host.js

import { harnessMode, savedSwitch, switchPath } from "../../host.js";

export { SESSION_NAME } from "../../host.js";

// the state file of one session
export function statePath(root, sessionID) {
  return switchPath(root, "opencode", sessionID);
}

// on or off for one session, and why
export async function sessionMode(root, sessionID, harness) {
  return harnessMode(harness, await savedSwitch(root, "opencode", sessionID));
}