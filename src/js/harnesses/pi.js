// the pi extension entry: pi -e ./src/js/harnesses/pi.js; see src/md/infrastructure/pi.md
// pi maps "typebox" to its own copy, so this file loads only inside pi

import { Type } from "typebox";
import { clankTalkExtension } from "./pi-host.js";

export default function (pi) {
  clankTalkExtension(pi, Type);
}
