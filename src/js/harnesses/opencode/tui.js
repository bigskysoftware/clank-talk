// opencode TUI part: /clank-talk and /taint for the human, with toasts and dialogs; see src/md/infrastructure/opencode.md
// opencode loads it beside index.js (a local plugin folder uses its tui file). Plain JS: no JSX, so no slot yet.
// These commands run in the TUI, so they never start a model turn, and the model cannot run them.

import fs from "node:fs/promises";
import nodePath from "node:path";
import * as untrusted from "../../untrusted.js";
import { taintCommand } from "../../taint-cli.js";
import { loadItems } from "../../taint-tui.js";
import { openFile, writePage } from "../../taint-page.js";
import { projectHarness } from "../../runtime.js";
import { projectRoot } from "../../host.js";

import { SESSION_NAME, sessionMode, statePath } from "./state.js";
import { ClankTalkChannel } from "./channel.js";

/**
 * Set up the TUI part.
 * @param {Object} context  opencode's TUI plugin context
 * @param {Object} [options]
 * @param {Function} [options.open]  for tests: in place of the browser opener
 */
export async function setup(context, options = {}) {
  const root = projectRoot(null, (context.location && context.location.directory) || process.cwd());
  const toast = (message, variant = "info") => context.ui.toast.show({ title: "ClankTalk", message, variant });
  const sessionID = () => {
    const route = context.ui.router.current();
    return route && route.type === "session" && SESSION_NAME.test(route.sessionID) ? route.sessionID : null;
  };

  // /clank-talk on | off for the current session, or a report
  async function clankTalk(input) {
    const arg = String(input || "").trim();
    const harness = await projectHarness(root);
    const id = sessionID();
    if (arg === "on" || arg === "off") {
      if (arg === "off" && harness.required) {
        toast("AGENTS.talk has require clank-talk, so ClankTalk stays on. To turn it off, remove that line.", "warning");
        return;
      }
      if (id === null) {
        toast("Open a session first: /clank-talk " + arg + " is for one session.", "warning");
        return;
      }
      await fs.mkdir(nodePath.dirname(statePath(root, id)), { recursive: true });
      await fs.writeFile(statePath(root, id), JSON.stringify({ on: arg === "on" }) + "\n");
      toast("ClankTalk is " + arg + " for this session." + (arg === "on" ? " Other tools are hidden and blocked." : ""), "success");
      return;
    }
    if (arg !== "") {
      toast("Usage: /clank-talk [on | off]", "warning");
      return;
    }
    const state = await sessionMode(root, id, harness);
    const lines = ["ClankTalk: " + (state.on ? "on" : "off") + " (" + state.why + ")", "allowed: clank_talk, question" + (harness.allowed.length > 0 ? ", " + harness.allowed.join(", ") : ""), "Other tools are " + (state.on ? "hidden and blocked." : "hidden and blocked when ClankTalk is on.")];
    const taint = [];
    await taintCommand(["--line"], root, (line) => taint.push(line));
    lines.push("taint: " + taint.join(" "));
    for (const error of harness.errors) {
      lines.push("AGENTS.talk error: " + error);
    }
    await context.ui.dialog.alert({ title: "ClankTalk", message: lines.join("\n") });
  }

  // /taint: a list of the inputs that are not approved; /taint clear approves all
  async function taint(input) {
    const arg = String(input || "").trim();
    if (arg === "clear") {
      const lines = [];
      await taintCommand(["clear"], root, (line) => lines.push(line), { by: "/taint clear" });
      toast(lines.join("\n"), "success");
      return;
    }
    if (arg !== "") {
      toast("Usage: /taint [clear]", "warning");
      return;
    }
    await review();
  }

  // the review: Enter or ctrl+o opens the input in the browser, ctrl+a approves it, ctrl+e approves all
  async function review() {
    const items = (await loadItems(root)).filter((item) => !item.entry.approved);
    if (items.length === 0) {
      toast("No untrusted inputs to approve.", "success");
      return;
    }
    const open = async (ref) => {
      const item = items.find((each) => each.ref === ref);
      if (item === undefined) {
        return;
      }
      const judge = item.entry.verdict ? item.entry.verdict.result : "-";
      const file = await writePage(root, item.session, item.entry, { ref: item.ref, status: "new", time: item.entry.time, source: item.entry.source, judge });
      await (options.open || openFile)(file);
    };
    const picked = await context.ui.dialog.select({
      title: "Untrusted inputs (" + items.length + " not approved)",
      options: items.map((item) => ({ title: untrusted.printable(item.entry.source), value: item.ref, description: item.ref + "  " + item.entry.time + "  " + item.entry.size + " bytes" })),
      actions: [
        { bind: "ctrl+o", title: "Open", onTrigger: (ref) => open(ref) },
        {
          bind: "ctrl+a",
          title: "Approve",
          onTrigger: async (ref) => {
            const item = items.find((each) => each.ref === ref);
            if (item !== undefined) {
              await untrusted.approve(root, item.session, [item.entry.n], "the opencode review");
              toast("Approved " + ref, "success");
              // a new list: another dialog closes this one
              await review();
            }
          },
        },
        { bind: "ctrl+e", title: "Approve all", side: "right", selection: "none", onTrigger: () => void taint("clear").then(() => context.ui.dialog.clear()) },
      ],
    });
    if (picked !== undefined) {
      await open(picked);
    }
  }

  // ask with real choices: the server part sends an ask event; this TUI says seen, shows a dialog, and sends the answer
  // Escape in a dialog is no answer (null), which a script treats as no; see channel.js
  async function answerAsk(event) {
    const data = event && event.data;
    const where = event && event.location && event.location.directory;
    if (!data || (where && projectRoot(null, where) !== root)) {
      return;
    }
    const channel = context.client.rpc(ClankTalkChannel);
    await channel.seen({ id: data.id });
    let answer = null;
    if (data.many) {
      // one yes or no dialog for each choice
      answer = [];
      for (const choice of data.choices) {
        const yes = await context.ui.dialog.confirm({ title: data.question, message: choice + "?", label: { confirm: "Yes", cancel: "No" } });
        if (yes === undefined) {
          answer = null;
          break;
        }
        if (yes) {
          answer.push(choice);
        }
      }
    } else if (data.choices.length > 0) {
      const picked = await context.ui.dialog.select({ title: data.question, current: data.choices[0], options: data.choices.map((choice) => ({ title: choice, value: choice })) });
      answer = picked === undefined ? null : picked;
    } else {
      const typed = await context.ui.dialog.prompt({ title: data.question });
      answer = typeof typed === "string" ? typed : null;
    }
    await channel.answer({ id: data.id, answer });
  }
  // with no RPC client (an older opencode), questions use the permission prompt of the server part
  let stopListening = null;
  try {
    stopListening = context.client.rpc(ClankTalkChannel).events.on("ask", (event) => void answerAsk(event).catch(() => {}));
  } catch {
    stopListening = null;
  }

  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      { id: "clank-talk.mode", title: "ClankTalk: on, off, or the report", group: "ClankTalk", palette: true, slash: { name: "clank-talk", arguments: true }, run: (input) => clankTalk(input) },
      { id: "clank-talk.taint", title: "ClankTalk: review untrusted inputs", group: "ClankTalk", palette: true, slash: { name: "taint", arguments: true }, run: (input) => taint(input) },
    ],
  }));

  return () => {
    if (typeof stopListening === "function") {
      stopListening();
    }
  };
}


export default { id: "clank-talk.tui", setup };