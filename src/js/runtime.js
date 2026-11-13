// Runtime: runs a parsed script
//
// Everything is async, so later commands (read, fetch, ask) can wait
// without changing how scripts are written.
//
// A runtime error stops the script. "on error" comes later.

import { parse } from "./parser.js";
import { helpIndex, helpFor, noHelp } from "./help.js";
import { unsafeConfig, guardArgs, gitEnv, isSafeBranchName, isSafeCommitName } from "./git.js";
import { Pattern, PatternWorker, PATTERN_TIME_LIMIT } from "./patterns.js";
import { keepItems, withNotes } from "./keeping.js";
import { sandboxKind, installDirs, sandboxPlan, makeHome, wrapCommand, selfTest } from "./sandbox.js";
import * as untrusted from "./untrusted.js";
import { judgeLines, judgeText } from "./judge.js";
import { runSubagent, anthropicModel, SubagentError, API_URL } from "./subagent.js";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { parseEnv } from "node:util";
import dns from "node:dns/promises";

const DEFAULT_MAX_STEPS = 100_000;
const AGENTS_TALK = "AGENTS.talk";

// error messages show at most this much of a value
const DESCRIBE_LENGTH = 80;

// how many scripts the undo list keeps
const UNDO_LIMIT = 20;

// the steps a hook can watch, apart from tool names
// git operations that change files or branches; "deny writes" denies them
const GIT_WRITES = ["switch", "commit", "merge", "rebase", "move", "delete", "stash", "restore", "pull", "tag"];
const HOOK_STEPS = ["read", "write", "append", "replace", "put", "remove", "move", "delete", "change", "undo", "run", "git", "fetch", "start", "stop"];

// a runtime error that knows where in the source it happened
class ScriptError extends Error {
  constructor(message, node) {
    super(message);
    this.line = node.line;
    this.column = node.column;
  }
}

// the host cancelled the script
class Cancelled extends ScriptError {}

// a "before" hook rejected a step, or a tool rejected its call; "on error" can handle this
class Rejected extends ScriptError {}

// the step budget is used up; "on error" cannot handle this
class StepBudget extends ScriptError {}

// a file in the project; nothing is read until a property is used
// folder: the path was written with a / at the end, such as @/migrations/
class FileRef {
  constructor(absolute, root, folder = false) {
    this.absolute = absolute;
    this.folder = folder;
    // the path relative to the project root, with / on every platform
    this.path = relativeName(root, absolute);
    this.name = nodePath.basename(absolute);
  }

  // in lists printed as JSON, a file shows its path
  toJSON() {
    return this.path;
  }
}

// one item of "the undo list": a script that undo can take back
class UndoStep {
  constructor(number, time, files) {
    this.number = number;
    this.time = time;
    this.files = files;
  }
}

// one line of a file; as text, a line is its content
// file is set for lines that find gives back, so they know where they came from
class Line {
  constructor(number, text) {
    this.number = number;
    this.text = text;
    this.file = null;
  }

  toJSON() {
    return this.text;
  }
}

// a secret: text that a script can send to an allowed host, but never see; see src/md/features/secrets.md
// the parts are text and { name, value } items, so 'Bearer ' + secret X is still a secret
class Secret {
  #parts;

  constructor(parts) {
    this.#parts = parts;
  }

  // text or a secret, joined with text or a secret: always a secret
  static join(left, right) {
    return new Secret([...Secret.partsOf(left), ...Secret.partsOf(right)]);
  }

  static partsOf(value) {
    if (value instanceof Secret) {
      return value.#parts;
    }
    return [toText(value)];
  }

  // the names of the secrets in it, each once
  names() {
    const names = [];
    for (const part of this.#parts) {
      if (typeof part !== "string" && !names.includes(part.name)) {
        names.push(part.name);
      }
    }
    return names;
  }

  // what print shows: Bearer <secret GITHUB_TOKEN>
  shown() {
    return this.#parts.map((part) => typeof part === "string" ? part : "<secret " + part.name + ">").join("");
  }

  // the real text, only for an allowed place
  reveal() {
    return this.#parts.map((part) => typeof part === "string" ? part : part.value).join("");
  }

  // JSON and plain JavaScript text never get the value: they fail, so a missed place fails closed
  toJSON() {
    throw new SecretUse(this, null);
  }

  toString() {
    throw new SecretUse(this, null);
  }
}

// a secret went to a place where it cannot go; runCommands gives it the command's line
// where is a word for the error, such as "'is'", or null to use the command's name
class SecretUse extends ScriptError {
  constructor(secret, where) {
    super("A secret cannot be used here: " + secret.names().join(", "), { line: 0, column: 0 });
    this.secret = secret;
    this.where = where;
  }
}

// how print starts a line: "12: ", or "src/a.js:12: " for a line from find
function lineLabel(line) {
  if (line.file !== null) {
    return line.file.path + ":" + line.number + ": ";
  }
  return line.number + ": ";
}

/**
 * Start a script, and give back an execution object at once.
 * The host can watch it, cancel it, and wait for it.
 *
 *   const execution = start(source, { onStep });
 *   execution.status     "running", "done", "failed" or "cancelled"
 *   execution.steps      steps so far
 *   execution.output     output lines so far
 *   execution.cancel()   stop the script at the next step
 *   execution.signal     an AbortSignal for slow work, such as tools
 *   execution.warnings problems that do not stop the script, such as a replace with no match
 *   await execution.done gives { status, output, errors, warnings, steps, changes }
 *
 * @param {string} source
 * @param {Object} [options]
 * @param {Object<string, Function>} [options.tools]  AGENTS.talk tools: name to async function({ signal })
 * @param {number} [options.maxSteps]                 the step budget
 * @param {Object} [options.globals]                  $ variables; pass the same object to keep them for a session
 * @param {Function} [options.onStep]                 called with { type, line, column, steps } before each step
 * @param {AbortSignal} [options.signal]              a host signal that cancels the script
 * @param {string} [options.root]                     the project root; files outside it are refused (default: process.cwd())
 * @param {string} [options.cwd]                      the directory for ./ and ../ paths (default: root)
 * @param {Map} [options.seen]                       files read so far; pass the same Map to check stale writes across runs
 * @param {Array} [options.undo]                     the undo list; pass the same array to undo across runs
 * @param {Set} [options.fetchHosts]                hosts the human allowed for fetch; pass the same Set for a session
 * @param {Function} [options.lookup]               for tests: (host) => addresses, in place of a DNS lookup
 * @param {Object} [options.policy]                 the harness's policy: { name, source }, ClankTalk text; see src/md/features/policy.md
 * @param {string} [options.agent]                  the name of the agent that sent the script; the audit records it
 * @param {Object} [options.audit]                  the audit session { scripts, records }; with it, each run appends to .talk/audit/
 * @param {Function} [options.ask]                   asks the human: async ({ question, choices, signal }) => text or null
 * @param {number} [options.askTimeLimit]            how long a question waits with no "within", in ms (default: 2 minutes)
 */
export function start(source, options = {}) {
  const controller = new AbortController();

  const execution = {
    status: "running",
    steps: 0,
    output: [],
    // every file write: { path, before, after }; before is null for a new file
    changes: [],
    errors: [],
    // problems that do not stop the script: { message, line, column, file }
    warnings: [],
    signal: controller.signal,
    cancel() {
      controller.abort();
    },
    done: null,
    // runs find, replace and matches with a pattern, in a worker thread with a time limit
    patterns: new PatternWorker(),
  };

  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort();
    } else {
      options.signal.addEventListener("abort", () => controller.abort());
    }
  }

  execution.done = execute(source, options, execution);
  return execution;
}

/**
 * Parse and run a script, and wait for the end. A short form of start(...).done.
 */
export async function run(source, options = {}) {
  return start(source, options).done;
}

async function execute(source, options, execution) {
  // wait one tick, so start() returns before the first step,
  // and the host has the execution object before onStep is called
  await null;

  const tools = options.tools || {};
  for (const name of Object.keys(tools)) {
    if (typeof hostTool(tools[name]).run !== "function") {
      return finish(execution, "failed", [{ message: "The host tool " + name + " has no run function", line: 0, column: 0 }]);
    }
  }
  const maxSteps = options.maxSteps || DEFAULT_MAX_STEPS;
  const root = nodePath.resolve(options.root || process.cwd());

  // the policy from the harness loads first; see src/md/features/policy.md
  const policy = loadPolicy(options.policy);
  if (policy.errors.length > 0) {
    return finish(execution, "failed", policy.errors);
  }

  const agents = await loadAgentsTalk(root, tools);
  if (agents.errors.length > 0) {
    return finish(execution, "failed", agents.errors);
  }
  const policyErrors = checkPolicy(policy.policy, agents);
  if (policyErrors.length > 0) {
    return finish(execution, "failed", policyErrors);
  }
  const secrets = await loadSecrets(root, agents.allowedSecrets);
  secrets.errors.push(...checkSecretUses(agents));
  secrets.errors.push(...checkSubagents(agents));
  secrets.errors.push(...checkHookCalls([...policy.hooks, ...agents.hooks], agents.definitions));
  if (secrets.errors.length > 0) {
    return finish(execution, "failed", secrets.errors);
  }
  // policy hooks run first, and AGENTS.talk cannot remove them
  const policyHookErrors = [];
  for (const hook of policy.hooks) {
    if (!HOOK_STEPS.includes(hook.name) && !Object.hasOwn(agents.definitions, hook.name) && !Object.hasOwn(tools, hook.name)) {
      policyHookErrors.push({ message: "Unknown step '" + hook.name + "' for a hook. Use " + HOOK_STEPS.join(", ") + ", or a tool name", line: hook.line, column: hook.column, file: policy.file });
    }
  }
  if (policyHookErrors.length > 0) {
    return finish(execution, "failed", policyHookErrors);
  }
  agents.hooks = [...policy.hooks, ...agents.hooks];

  const toolNames = Object.keys(tools).concat(Object.keys(agents.definitions));
  const { script, errors } = parse(source, { tools: toolNames });
  if (errors.length > 0) {
    return finish(execution, "failed", errors);
  }
  // in a host session, the first line '# ...' is the script's purpose in the audit header; see src/md/features/audit.md
  if (options.audit && !source.startsWith("#") && !options.audit.warnedPurpose) {
    // once in each session, so it does not repeat on every result
    options.audit.warnedPurpose = true;
    execution.warnings.push({ message: "Start the script with a # line that says what it is for, in a few words. The human reads it in the audit.", line: 1, column: 1 });
  }

  const state = {
    execution,
    root,
    definitions: agents.definitions,
    // real path to the text the script last read or wrote; a host can keep it between runs
    seen: options.seen || new Map(),
    // "on error" for the script now running (a tool has its own), and true while it runs
    handler: findHandler(script.commands),
    handling: false,
    allowedEnv: agents.allowedEnv,
    // hidden paths that scripts can change, from "allow changes to" in AGENTS.talk, relative to the root
    allowedChanges: agents.allowedChanges,
    // hosts from "allow fetch from" in AGENTS.talk, and hosts the human said yes to in this session
    allowedFetch: agents.allowedFetch,
    trustedFetch: agents.trustedFetch,
    fetchHosts: options.fetchHosts || new Set(),
    lookup: options.lookup || lookupHost,
    // secrets from "allow secret" in AGENTS.talk, by name: { name, hosts, value }; value is null when not set
    secrets: secrets.secrets,
    // background processes by name; a host keeps the Map for a session, and stops them at the end
    processes: options.processes || new Map(),
    // the full print output of the last script, from the host; null before the first script
    previousOutput: options.previousOutput === undefined ? null : options.previousOutput,
    // hooks from AGENTS.talk, and true while one runs (commands in a hook do not run hooks)
    hooks: agents.hooks,
    inHook: false,
    tools,
    maxSteps,
    // the time limit for "run", in ms, from "within" on a tool call; null for no limit
    timeLimit: null,
    cwd: nodePath.resolve(root, options.cwd || "."),
    onStep: options.onStep || null,
    variables: Object.create(null),
    globals: options.globals || Object.create(null),
    result: null,
    // session taint: "on" or "off", and the size that the store keeps of one input; see src/js/untrusted.js
    taintMode: untrusted.taintMode(agents.taint, policy.policy !== null && policy.policy.rules.some((rule) => rule.type === "requireTaint"), await untrusted.commandLineMode(root)),
    keepUntrustedBytes: agents.keepUntrustedBytes || untrusted.DEFAULT_KEEP_BYTES,
    // the actions that ask while untrusted inputs are not approved: "taint asks before", or a light default
    taintAsks: agents.taintAsks || DEFAULT_TAINT_ASKS,
    // the .talk file of the tool or hook now running; null for the script
    file: null,
    // the scripts that undo can take back, oldest first; a host keeps it for a session
    undo: options.undo || [],
    // how many of the execution's changes are on the undo list already
    recordedChanges: 0,
    // the host's way to ask the human: async ({ question, choices, signal }) => text or null
    ask: options.ask || null,
    // subagents: the host's name, a host that lends its model (pi): (name or null) => model or null,
    // the API URL (tests use a local one), and the "use model" line
    harness: options.harness || "this host",
    // the host's options, for the small scripts that a background subagent runs
    options,
    lendModel: options.lendModel || null,
    subagentUrl: options.subagentUrl || API_URL,
    useModel: agents.useModel,
    // the judge: its model (null: the subagent model), and its lines in AGENTS.talk; see src/js/judge.js
    judge: agents.judge,
    // how long a question waits when it has no "within"; a host can change it
    askTimeLimit: options.askTimeLimit || ASK_TIME_LIMIT,
    askTimedOut: false,
    // the audit: the session (script count and records; a host keeps it), this script's steps,
    // the files this script read, where a step runs (script, a tool name, or a hook), and the format
    audit: options.audit || { scripts: 0, records: [] },
    // the file in .talk/audit/ is written only for a host session; the MCP host always passes one
    auditToFile: options.audit !== undefined,
    auditScript: 0,
    auditSteps: [],
    auditReads: new Set(),
    auditFrom: "script",
    // the script line of the command now running, and its 'because' reason, for each audit step
    auditLine: null,
    auditBecause: null,
    auditFormat: agents.auditFormat,
    // how many days of audit files to keep: AGENTS.talk, or the default, but never fewer than the policy says
    auditKeepDays: keepDays(agents, policy.policy),
    // the name of the agent that sent the script, or null; the audit records it
    agent: options.agent || null,
    // the host's name for this session, such as claude-code-4f2a; the audit records it
    session: options.session || null,
    // the harness's policy: name, short hash and rules, or null
    policy: policy.policy,
  };
  // the command line cannot see the policy, so a policy that requires taint leaves a note in .talk/
  if (policy.policy !== null || fsSync.existsSync(nodePath.join(root, untrusted.POLICY_FILE))) {
    try {
      await untrusted.notePolicy(root, policy.policy !== null && policy.policy.rules.some((rule) => rule.type === "requireTaint") ? policy.policy.name : null);
    } catch (err) {
      execution.warnings.push({ message: "Could not write " + untrusted.POLICY_FILE + ": " + err.message, line: 1, column: 1 });
    }
  }
  // '*' in allow or trust is a wide door, so each run says so; the audit has each fetch
  for (const warning of wideFetchWarnings(agents)) {
    execution.warnings.push({ message: warning, line: 1, column: 1 });
  }
  // limit output keeping ...: AGENTS.talk, then the policy; each cuts what the one before it kept, and the host cuts last
  const policyLimit = policy.policy === null ? null : policy.policy.rules.find((rule) => rule.type === "outputLimit") || null;
  execution.outputLimits = [agents.outputLimit, policyLimit].filter((limit) => limit !== null);
  state.audit.scripts++;
  state.auditScript = state.audit.scripts;

  let status = "done";
  let failure = [];
  try {
    await runCommands(script.commands, state);
  } catch (err) {
    execution.patterns.stop();
    if (err instanceof Cancelled) {
      status = "cancelled";
      failure = [errorFor(err)];
    } else if (err instanceof ScriptError) {
      status = "failed";
      failure = [errorFor(err)];
    } else {
      recordUndo(state);
      await writeAudit(state, source, "failed", [{ message: err.message, line: 0, column: 0 }]);
      throw err;
    }
  }

  execution.patterns.stop();
  recordUndo(state);
  // the host shows the changed files to the agent; undo has its own copy of the text, so only the copy for the host is redacted
  execution.changes = execution.changes.map((change) => ({ ...change, before: redact(change.before, state), after: redact(change.after, state) }));
  // errors and warnings go to the agent, so a secret's value in them shows as <secret NAME>
  failure = failure.map((error) => ({ ...error, message: redact(nullHint(error.message), state) }));
  await limitOutput(execution, state);
  for (const warning of execution.warnings) {
    warning.message = redact(warning.message, state);
  }
  await writeAudit(state, source, status, failure);
  return finish(execution, status, failure);
}

// ----- secrets -----
// see src/md/features/secrets.md

// a value shorter than this would match common text, so it cannot be kept out of the output
const SECRET_MIN_LENGTH = 8;

// the values of the secrets that AGENTS.talk allows: the environment first, then .env.local, then .env
// the files are read on each run, so a change takes effect at once
async function loadSecrets(root, allowed) {
  const secrets = new Map();
  const errors = [];
  if (allowed.length === 0) {
    return { secrets, errors };
  }
  const local = await readEnvFile(nodePath.join(root, ".env.local"));
  const base = await readEnvFile(nodePath.join(root, ".env"));
  for (const { name, hosts, run, subagents, where } of allowed) {
    let entry = secrets.get(name);
    if (entry === undefined) {
      let value = process.env[name];
      if (value === undefined || value === "") {
        value = local[name];
      }
      if (value === undefined || value === "") {
        value = base[name];
      }
      if (value === undefined || value === "") {
        value = null;
      }
      if (value !== null && value.length < SECRET_MIN_LENGTH) {
        errors.push({ message: "The value of secret " + name + " is shorter than " + SECRET_MIN_LENGTH + " characters, so it cannot be kept out of the output. Use a longer value, or remove the allow line.", ...where });
      }
      entry = { name, hosts: [], run: false, subagents: false, value };
      secrets.set(name, entry);
    }
    entry.hosts.push(...hosts);
    if (run) {
      entry.run = true;
    }
    if (subagents) {
      entry.subagents = true;
    }
  }
  return { secrets, errors };
}

// load errors: a name in both "allow env" and "allow secret", and "using secret" with no "allow secret ... for run"
function checkSecretUses(agents) {
  const errors = [];
  for (const { name, where } of agents.allowedSecrets) {
    if (agents.allowedEnv.includes(name)) {
      errors.push({ message: name + " is in both 'allow env' and 'allow secret'. Remove it from 'allow env', so only the runs that are provided it get it.", ...where });
    }
  }
  const forRun = agents.allowedSecrets.filter((allowed) => allowed.run).map((allowed) => allowed.name);
  for (const definition of Object.values(agents.definitions)) {
    for (const node of findNodes(definition, [])) {
      if ((node.type !== "run" && node.type !== "start") || node.secrets.length === 0) {
        continue;
      }
      for (const name of node.secrets) {
        if (!forRun.includes(name)) {
          errors.push({ message: "The tool " + definition.name + " is provided secret " + name + ", but AGENTS.talk has no 'allow secret " + name + " for run'.", line: node.line, column: node.column, file: definition.file });
        }
      }
    }
  }
  return errors;
}

// ----- subagents; see src/md/features/subagents.md -----

// at most this many tool calls, and this long, for one subagent
const SUBAGENT_MAX_CALLS = 20;
const SUBAGENT_TIME_LIMIT = 5 * 60 * 1000;

// steps that a tool in a "with only" list cannot have: injected text can choose its arguments
const SUBAGENT_UNSAFE = ["write", "append", "put", "remove", "replaceLines", "removeLines", "move", "delete", "fetch", "git", "start"];

// load errors: the model's key must be allowed for subagents, and each "with only" tool must exist and be safe
function checkSubagents(agents) {
  const errors = [];
  for (const model of [agents.useModel, agents.judge.model]) {
    if (model !== null && model.secret !== null && !agents.allowedSecrets.some((allowed) => allowed.name === model.secret && allowed.subagents)) {
      errors.push({ message: "'use model' needs its key allowed for subagents. Add: allow secret " + model.secret + " for subagents", ...model.where });
    }
  }
  for (const definition of Object.values(agents.definitions)) {
    for (const node of findNodes(definition, [])) {
      if ((node.type !== "run" && node.type !== "start") || !node.subagent) {
        continue;
      }
      const where = { line: node.line, column: node.column, file: definition.file };
      for (const name of node.subagent.tools) {
        const tool = agents.definitions[name];
        if (tool === undefined) {
          errors.push({ message: "A subagent can use only tools from AGENTS.talk, and there is no tool " + name, ...where });
          continue;
        }
        const unsafe = unsafeForSubagent(tool, agents.definitions, new Set());
        if (unsafe !== null) {
          errors.push({ message: "The tool " + name + " cannot be in a subagent's 'with only' list, because it uses " + unsafe + ". Injected text could choose its arguments", ...where });
        }
      }
    }
  }
  return errors;
}

// run is not allowed in a hook, and commands in a hook run no hooks, so a hook cannot call a tool that runs
// a program either: no "before run" hook would see it; see src/md/features/hooks.md
function checkHookCalls(hooks, definitions) {
  const errors = [];
  for (const hook of hooks) {
    for (const node of findNodes(hook, [])) {
      const called = node.type === "toolCall" ? definitions[node.name] : undefined;
      if (called !== undefined && runsProgram(called, definitions, new Set())) {
        errors.push({ message: "A hook cannot call '" + node.name + "', because it runs a program, and run is not allowed in a hook", line: node.line, column: node.column, file: hook.file });
      }
    }
  }
  return errors;
}

// true if the tool, or a tool that it calls, runs or starts a program
function runsProgram(tool, definitions, seen) {
  seen.add(tool.name);
  for (const node of findNodes(tool, [])) {
    if (node.type === "run" || node.type === "start") {
      return true;
    }
    const called = node.type === "toolCall" ? definitions[node.name] : undefined;
    if (called !== undefined && !seen.has(node.name) && runsProgram(called, definitions, seen)) {
      return true;
    }
  }
  return false;
}

// the first step that a subagent must not reach, in the tool or in any tool it calls, or null
// a host tool cannot be looked into, so it counts as unsafe; seen stops a loop of calls
function unsafeForSubagent(tool, definitions, seen) {
  seen.add(tool.name);
  for (const node of findNodes(tool, [])) {
    if (node.type === "toolCall") {
      const called = definitions[node.name];
      if (called === undefined) {
        return "the host tool " + node.name;
      }
      if (!seen.has(node.name)) {
        const inner = unsafeForSubagent(called, definitions, seen);
        if (inner !== null) {
          return inner + " (through the tool " + node.name + ")";
        }
      }
      continue;
    }
    if (SUBAGENT_UNSAFE.includes(node.type)) {
      return "'" + node.type + "'";
    }
    // replace in a variable is fine; replace in a file is a write
    if (node.type === "replace" && node.target && node.target.type !== "variable" && node.target.type !== "result") {
      return "'replace' in a file";
    }
    if ((node.type === "run" || node.type === "start") && node.subagent) {
      return "another subagent";
    }
  }
  return null;
}

// a tool argument from a model: text as it is, a list or object as JSON text (as print shows it), and null for none
function inputText(value) {
  if (value === undefined || value === null) {
    return null;
  }
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

// the model for a subagent: the host lends one (pi), or the API with the key from "use model"
function subagentModel(state, node) {
  const use = state.useModel;
  if (state.lendModel !== null) {
    try {
      return state.lendModel(use === null ? null : use.model);
    } catch (err) {
      throw new ScriptError(err.message, node);
    }
  }
  if (use === null || use.secret === null) {
    throw new ScriptError("This harness (" + state.harness + ") cannot lend its model to a subagent. Add a model and a key to AGENTS.talk: use model 'claude-sonnet-5-5' for subagents with secret ANTHROPIC_API_KEY", node);
  }
  const entry = state.secrets.get(use.secret);
  if (entry === undefined || entry.value === null) {
    throw new ScriptError("No value for secret " + use.secret + ". Put it in the environment, in .env.local or in .env.", node);
  }
  return anthropicModel({ url: state.subagentUrl, key: entry.value, model: use.model });
}

// the tools that a subagent can call, as the model sees them
function subagentTools(state, names) {
  return names.map((name) => ({ name, description: state.definitions[name].description || "A ClankTalk tool.", params: state.definitions[name].params }));
}

// the answer to a subagent that calls a tool that is not in its list
function noSuchTool(name, names) {
  return { content: "There is no tool named " + name + ". Use: " + names.join(", "), isError: true };
}

// run '<prompt>' in a subagent with only <tools>: the answer is untrusted text
async function runSubagentCommand(command, state) {
  checkDenied("subagents", state, command);
  const prompt = redact(toText(await evaluate(command.program, state)), state);
  const ask = subagentModel(state, command);
  const owner = "subagent " + state.auditFrom;
  const tools = subagentTools(state, command.subagent.tools);
  let limit = shorter(state.timeLimit, SUBAGENT_TIME_LIMIT);
  if (command.within !== null) {
    limit = shorter(limit, await durationMs(command.within, state));
  }
  const timeout = AbortSignal.timeout(limit);
  const signal = AbortSignal.any([state.execution.signal, timeout]);

  const callOne = async (name, input) => {
    if (!command.subagent.tools.includes(name)) {
      return noSuchTool(name, command.subagent.tools);
    }
    takeStep(command, state);
    const definition = state.definitions[name];
    const args = definition.params.map((param) => inputText(input[param]));
    const savedFrom = state.auditFrom;
    state.auditFrom = owner;
    try {
      const step = toolStep(definition, args, Object.create(null));
      await runHooks("before", [name], step, state, command);
      auditStep(state, "tool", name, args.map((arg) => toText(arg)).join(", "));
      const result = await callTool(definition, args, Object.create(null), command, state);
      await runHooks("after", [name], step, state, command);
      return { content: redact(toText(showSecrets(result)), state), isError: false };
    } catch (err) {
      if (!(err instanceof ScriptError) || err instanceof Cancelled || err instanceof StepBudget) {
        throw err;
      }
      return { content: redact(err.message, state), isError: true };
    } finally {
      state.auditFrom = savedFrom;
    }
  };

  let answer;
  try {
    answer = await runSubagent({ ask, prompt, tools, callTool: callOne, maxCalls: SUBAGENT_MAX_CALLS, signal });
  } catch (err) {
    if (state.execution.signal.aborted) {
      throw new Cancelled("Cancelled", command);
    }
    if (timeout.aborted) {
      throw new ScriptError("The subagent did not finish within " + limit + "ms", command);
    }
    if (err instanceof SubagentError) {
      throw new ScriptError(redact(err.message, state), command);
    }
    // a bad answer from the API or a model that fails: a script error, not a crash
    if (!(err instanceof ScriptError)) {
      throw new ScriptError("The subagent failed: " + redact(String(err && err.message), state), command);
    }
    throw err;
  }
  auditStep(state, "subagent", owner, answer.calls + (answer.calls === 1 ? " tool call" : " tool calls"));
  // a model wrote the answer after it read tool output, so it is always untrusted
  const text = redact(answer.text, state);
  await noteUntrusted(state, owner + ": " + describe(prompt), text);
  return text;
}

// start '<prompt>' in a subagent with only <tools> as '<name>': the same subagent, in the background
// the script that starts it ends before it does, so each tool call runs as its own small script,
// with the host's options, and the tool's arguments in $ globals (never in the script text)
async function startSubagent(command, state) {
  checkDenied("subagents", state, command);
  const name = await processName(command, state);
  const prompt = redact(toText(await evaluate(command.program, state)), state);
  const ask = subagentModel(state, command);
  const owner = "subagent " + name;
  const allowed = command.subagent.tools;
  const tools = subagentTools(state, allowed);
  const options = state.options;
  const callOne = async (tool, input) => {
    if (!allowed.includes(tool)) {
      return noSuchTool(tool, allowed);
    }
    const globals = Object.create(null);
    const names = state.definitions[tool].params.map((param, index) => {
      globals["$arg" + index] = inputText(input[param]);
      return "$arg" + index;
    });
    const source = "print " + tool + (names.length > 0 ? " " + names.join(", ") : "");
    const result = await run(source, { ...options, globals, agent: "subagent-" + name, seen: new Map(), undo: [], onStep: null, previousOutput: null });
    if (result.errors.length > 0) {
      return { content: result.errors.map((error) => error.message).join("\n"), isError: true };
    }
    return { content: result.output.join("\n"), isError: false };
  };

  const abort = new AbortController();
  const record = { name, child: null, abort, subagent: owner, status: "running", code: null, output: "" };
  state.processes.delete(name);
  state.processes.set(name, record);
  auditStep(state, "start", name, "subagent with only " + allowed.join(", "));
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(SUBAGENT_TIME_LIMIT)]);
  runSubagent({ ask, prompt, tools, callTool: callOne, maxCalls: SUBAGENT_MAX_CALLS, signal }).then(
    (answer) => {
      if (record.status === "running") {
        record.output = redact(answer.text, state);
        record.status = "exited";
        record.code = 0;
      }
    },
    (err) => {
      if (record.status === "running") {
        record.output = redact(signal.aborted ? "The subagent did not finish within " + SUBAGENT_TIME_LIMIT + "ms" : err.message, state);
        record.status = "exited";
        record.code = 1;
      }
    },
  );
  return new ProcessInfo(record, state);
}

// the environment for a run or start: "allow env", and the secrets it is provided with "using secret"
function programEnv(command, state) {
  const env = allowedEnvFor(state);
  for (const name of command.secrets) {
    const entry = state.secrets.get(name);
    if (entry.value === null) {
      throw new ScriptError("No value for secret " + name + ". Put it in the environment, in .env.local or in .env.", command);
    }
    env[name] = entry.value;
  }
  return env;
}

// the end of an audit line for a step that sends secrets: "  (secret A, B)"
function secretNote(names) {
  return names.length === 0 ? "" : "  (secret " + names.join(", ") + ")";
}

// KEY=value lines, with the dotenv rules (node:util parseEnv): # comments, "export ", quotes, backticks,
// and double-quoted values on more than one line; a missing file is empty
async function readEnvFile(absolute) {
  let text;
  try {
    text = await fs.readFile(absolute, "utf8");
  } catch (err) {
    return Object.create(null);
  }
  return Object.assign(Object.create(null), parseEnv(text));
}

// secret NAME: an error if AGENTS.talk does not allow it, or if it has no value
function secretValue(node, state) {
  const entry = state.secrets.get(node.name);
  if (entry === undefined) {
    throw new ScriptError("AGENTS.talk does not allow secret " + node.name + ".\nTo allow it, a human can add this line to AGENTS.talk:\n  allow secret " + node.name + " for fetch to '<host>'", node);
  }
  if (entry.value === null) {
    throw new ScriptError("No value for secret " + node.name + ". Put it in the environment, in .env.local or in .env.", node);
  }
  return new Secret([{ name: node.name, value: entry.value }]);
}

// the error for a secret in the wrong place, with the places where it can go
function secretUseMessage(secret, where, state) {
  const names = secret.names();
  const hosts = [];
  let run = false;
  for (const name of names) {
    const entry = state.secrets.get(name);
    if (entry === undefined) {
      continue;
    }
    for (const host of entry.hosts) {
      if (!hosts.includes(host)) {
        hosts.push(host);
      }
    }
    if (entry.run) {
      run = true;
    }
  }
  const places = [];
  if (hosts.length > 0) {
    places.push("in fetch headers or body to " + hosts.join(", "));
  }
  if (run) {
    places.push("in a tool, with: run ... using secret " + names[0]);
  }
  const start = where === null ? "A secret cannot be used here: " : "A secret cannot go into " + where + ": ";
  return start + names.join(", ") + ". Use it " + places.join(", or ") + ".";
}

// the text with each allowed secret's value as <secret NAME>
function redact(text, state) {
  if (typeof text !== "string") {
    return text;
  }
  for (const entry of state.secrets.values()) {
    if (entry.value !== null) {
      text = text.split(entry.value).join("<secret " + entry.name + ">");
    }
  }
  return text;
}

// a copy of a value with each secret as change(secret) gives it
// lists and plain objects are copied only when they hold a secret
function mapSecrets(value, change) {
  if (value instanceof Secret) {
    return change(value);
  }
  if (!hasSecret(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => mapSecrets(item, change));
  }
  const copy = Object.create(null);
  for (const key of Object.keys(value)) {
    copy[key] = mapSecrets(value[key], change);
  }
  return copy;
}

// a copy of a value with each secret as <secret NAME>, for print and error messages
function showSecrets(value) {
  return mapSecrets(value, (secret) => secret.shown());
}

// does a value, or a list or plain object in it, hold a secret?
function hasSecret(value) {
  if (value instanceof Secret) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some(hasSecret);
  }
  if (isPlainObject(value)) {
    return Object.values(value).some(hasSecret);
  }
  return false;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

// a copy of a value with each secret as its real text, for a fetch; the names go into used
function revealSecrets(value, used) {
  return mapSecrets(value, (secret) => {
    for (const name of secret.names()) {
      if (!used.includes(name)) {
        used.push(name);
      }
    }
    return secret.reveal();
  });
}

// the words for file errors from the system; the code goes in the message too
const SYSTEM_ERRORS = {
  EACCES: "permission denied",
  EPERM: "permission denied",
  ELOOP: "too many links",
  ENOTDIR: "a part of the path is not a folder",
  EISDIR: "it is a folder",
  ENAMETOOLONG: "the name is too long",
  ENOSPC: "the disk is full",
  EROFS: "the file system is read-only",
  EBUSY: "the file is busy",
  EMFILE: "too many open files",
  EEXIST: "it exists",
  ENOENT: "not found",
};

// a raw JavaScript or system error becomes a script error at the command, so "on error" can handle it,
// and the agent does not see a path on the host; other errors stay as they are
function scriptErrorFor(err, node, state) {
  if (err instanceof ScriptError || !(err instanceof Error)) {
    return err;
  }
  const message = systemMessage(err, state);
  return message === null ? err : new ScriptError(message, node);
}

function systemMessage(err, state) {
  if (err instanceof RangeError && err.message.includes("call stack")) {
    return "The script nests too deep to run. Use variables for parts of it";
  }
  if (err instanceof RangeError && /Invalid (string|array) length/.test(err.message)) {
    return "A value is too large. Make it smaller";
  }
  if (err instanceof TypeError && err.message.includes("circular")) {
    return "A value holds itself, so it cannot become text";
  }
  if (err.code === "ERR_INVALID_ARG_VALUE" && err.message.includes("null bytes")) {
    return "A value holds a NUL character, and a program cannot take it. Remove the character";
  }
  if (typeof err.code === "string" && typeof err.syscall === "string") {
    return "Cannot " + err.syscall + " " + systemPath(err.path, state) + ": " + (SYSTEM_ERRORS[err.code] || "system error") + " (" + err.code + ")";
  }
  return null;
}

// a path from a system error, relative to the project; a path outside it is not shown
function systemPath(absolute, state) {
  if (typeof absolute !== "string") {
    return "a file";
  }
  // the system gives the real path, after links, and the root can be a link (on macOS, /var is /private/var)
  for (const root of [state.root, realRootSync(state.root)]) {
    if (isInside(absolute, root)) {
      return relativeName(root, absolute) || ".";
    }
  }
  return "a file outside the project";
}

function realRootSync(root) {
  try {
    return fsSync.realpathSync(root);
  } catch {
    return root;
  }
}

// an error object for the host; "file" is there only for errors in AGENTS.talk
function errorFor(err) {
  const result = { message: err.message, line: err.line, column: err.column };
  if (err.file) {
    result.file = err.file;
  }
  return result;
}

/**
 * The tools in AGENTS.talk, for a host to show to the agent.
 * @param {string} root  the project root
 * @returns {Promise<{ tools: { name: string, params: string[] }[], errors: Object[] }>}
 */
export async function listTools(root) {
  const agents = await loadAgentsTalk(nodePath.resolve(root), {});
  const tools = [];
  for (const name of Object.keys(agents.definitions)) {
    tools.push({ name, params: agents.definitions[name].params, description: agents.definitions[name].description });
  }
  return { tools, errors: agents.errors };
}

// the "#" comment lines just above a line, as text, with the "#" removed
function commentAbove(source, lineNumber) {
  const lines = source.split("\n");
  const comment = [];
  let index = lineNumber - 2;
  while (index >= 0 && lines[index].trim().startsWith("#")) {
    comment.unshift(lines[index].trim().replace(/^#\s?/, ""));
    index--;
  }
  return comment.join("\n");
}

// the tools for help: AGENTS.talk tools with their comments, then host tools
function toolList(state, hostTools) {
  const list = [];
  for (const name of Object.keys(state.definitions)) {
    const definition = state.definitions[name];
    list.push({ name, params: definition.params, description: definition.description || "" });
  }
  for (const name of Object.keys(hostTools)) {
    const host = hostTool(hostTools[name]);
    list.push({ name, params: host.params, description: host.description || "A tool from the host." });
  }
  return list;
}

// the harness's policy: { name, source } from options.policy, or nothing
// gives { policy: { name, hash, rules } or null, hooks, file, errors }
// the policy is trusted text from the harness, outside the project; see src/md/features/policy.md
function loadPolicy(given) {
  const result = { policy: null, hooks: [], file: null, errors: [] };
  if (given === undefined || given === null) {
    return result;
  }
  const file = given.name || "policy.talk";
  result.file = file;
  const { script, errors } = parse(given.source, { definitions: true, policy: true });
  for (const e of errors) {
    result.errors.push({ ...e, file });
  }
  if (errors.length > 0) {
    return result;
  }
  const hash = createHash("sha256").update(given.source).digest("hex").slice(0, 8);
  const rules = [];
  let name = file;
  for (const definition of script.definitions) {
    if (definition.type === "policyName") {
      name = definition.name;
    } else if (definition.type === "hook") {
      definition.file = file;
      result.hooks.push(definition);
    } else {
      rules.push({ ...definition, file });
    }
  }
  result.policy = { name, hash, rules };
  return result;
}
// AGENTS.talk must stay inside the policy; each problem is a load error that names both lines
// see src/md/features/policy.md
function checkPolicy(policy, agents) {
  const errors = [];
  if (policy === null) {
    return errors;
  }
  const limits = Object.create(null);
  const denied = Object.create(null);
  let sandboxRule = null;
  for (const rule of policy.rules) {
    if (rule.type === "limit") {
      // two lines for one limit would mean one thing at load and another at run: one line only
      if (limits[rule.what] !== undefined) {
        errors.push({ message: "Only one 'limit " + rule.what + "' line is allowed in a policy: " + ruleAt(rule) + " is a second one. Put all the values on one line", line: 1, column: 1 });
      }
      limits[rule.what] = rule;
    } else if (rule.type === "deny") {
      denied[rule.what] = rule;
    } else if (rule.type === "requireSandbox") {
      sandboxRule = rule;
    }
  }
  // deny trust: no "trust fetch from" line
  if (denied.trust && agents.trustedFetch.length > 0) {
    errors.push({ message: "This trusts fetched text, and " + ruleAt(denied.trust) + " denies trust", ...agents.trustWhere });
  }
  const outside = (shown, rule) => {
    return "'" + shown + "' is outside the policy: " + ruleAt(rule) + " limits " + rule.what + " to " + rule.values.join(", ");
  };
  for (const { definition, where } of agents.allows) {
    // allow secret: inside "deny secrets", "limit secrets to" and "limit fetch from"
    if (definition.type === "allowSecret") {
      if (denied.secrets) {
        errors.push({ message: "This uses secrets, and " + ruleAt(denied.secrets) + " denies secrets", ...where });
      } else if (limits.secrets && !limits.secrets.values.includes(definition.name)) {
        errors.push({ message: outside("allow secret " + definition.name, limits.secrets), ...where });
      }
      if (limits.fetch) {
        for (const host of definition.hosts) {
          if (!isFetchHostInside(ruleHost(host), limits.fetch.values)) {
            errors.push({ message: outside("allow secret " + definition.name + " for fetch to " + shownRule(host), limits.fetch), ...where });
          }
        }
      }
    }
    if (definition.type === "allowFetch" && limits.fetch) {
      for (const host of definition.hosts) {
        if (!isFetchHostInside(ruleHost(host), limits.fetch.values)) {
          errors.push({ message: outside("allow fetch from " + shownRule(host), limits.fetch), ...where });
        }
      }
    }
    if (definition.type === "allowEnv" && limits.env) {
      for (const name of definition.names) {
        if (!limits.env.values.includes(name)) {
          errors.push({ message: outside("allow env " + name, limits.env), ...where });
        }
      }
    }
    if (definition.type === "allowChanges" && limits.changes) {
      for (const shown of definition.paths) {
        const path = plainPath(shown);
        if (!limits.changes.values.some((limit) => path === plainPath(limit) || path.startsWith(plainPath(limit) + "/"))) {
          errors.push({ message: outside("allow changes to " + shown, limits.changes), ...where });
        }
      }
    }
  }
  // keep audit: AGENTS.talk cannot keep fewer days than the policy
  const keep = policy.rules.find((rule) => rule.type === "keepAudit");
  if (keep !== undefined && agents.keepAudit !== null && agents.keepAudit.days < keep.days) {
    errors.push({ message: "'keep audit for " + agents.keepAudit.days + " days' is fewer than the policy: " + ruleAt(keep) + " keeps the audit for at least " + keep.days + " days", ...agents.keepAudit.where });
  }
  // tools and hooks in AGENTS.talk cannot use what the policy denies
  for (const definition of [...Object.values(agents.definitions), ...agents.hooks]) {
    for (const node of findNodes(definition, [])) {
      const where = { line: node.line, column: node.column, file: definition.file };
      for (const what of deniedUses(node)) {
        if (denied[what]) {
          errors.push({ message: "This uses " + what + ", and " + ruleAt(denied[what]) + " denies " + what, ...where });
        }
      }
      if (sandboxRule !== null && sandboxRule.commands.includes(node.type) && (node.sandbox === null || node.sandbox === undefined)) {
        errors.push({ message: "This " + node.type + " needs 'in a sandbox': " + ruleAt(sandboxRule) + " requires it", ...where });
      }
    }
  }
  return errors;
}

// where a policy rule is, for an error: "acme.talk 3:1"
function ruleAt(rule) {
  return rule.file + " " + rule.line + ":" + rule.column;
}

// @/.github/ and ./.github give .github
function plainPath(shown) {
  return shown.replace(/^@\//, "").replace(/^\.\//, "").replace(/\/+$/, "");
}

// a host or a *. pattern from "allow fetch from" is inside the policy's "limit fetch from"
function isFetchHostInside(host, limits) {
  if (host.startsWith("*.")) {
    return limits.some((limit) => limit.startsWith("*.") && host.slice(1).endsWith(limit.slice(1)));
  }
  return isAllowedFetchHost(host, limits);
}

// every node with a type under a node, for the load checks
function findNodes(node, found) {
  if (Array.isArray(node)) {
    for (const item of node) {
      findNodes(item, found);
    }
  } else if (node !== null && typeof node === "object") {
    if (typeof node.type === "string") {
      found.push(node);
    }
    for (const value of Object.values(node)) {
      findNodes(value, found);
    }
  }
  return found;
}

// what a node uses that a policy can deny: git push, start, fetch, run, writes
function deniedUses(node) {
  if (node.type === "git") {
    if (node.operation === "push") {
      return ["git push"];
    }
    return GIT_WRITES.includes(node.operation) ? ["writes"] : [];
  }
  // a subagent is not a program: deny subagents covers it
  if ((node.type === "run" || node.type === "start") && node.subagent) {
    return ["subagents"];
  }
  if (["start", "fetch", "run"].includes(node.type)) {
    return [node.type];
  }
  if (["write", "append", "replaceLines", "removeLines", "put", "undo"].includes(node.type)) {
    return ["writes"];
  }
  return [];
}

// at run time: a thing the policy denies is an error, whatever AGENTS.talk says
function checkDenied(what, state, node) {
  if (state.policy === null) {
    return;
  }
  for (const rule of state.policy.rules) {
    if (rule.type === "deny" && rule.what === what) {
      throw new ScriptError("The policy '" + state.policy.name + "' denies " + what + " in this session (" + ruleAt(rule) + ")", node);
    }
  }
}

// at run time: "require sandbox for run, start" makes a run or start with no sandbox an error
function checkSandboxRequired(what, sandbox, state, node) {
  if (state.policy === null || sandbox !== null) {
    return;
  }
  for (const rule of state.policy.rules) {
    if (rule.type === "requireSandbox" && rule.commands.includes(what)) {
      throw new ScriptError("The policy '" + state.policy.name + "' requires 'in a sandbox' for " + what + " (" + ruleAt(rule) + ")", node);
    }
  }
}

// the lines that only AGENTS.talk can have, by type, with the words for the error
const AGENTS_TALK_ONLY = {
  requireClankTalk: "require clank-talk",
  allowHarnessTools: "allow harness tools",
  allowEnv: "allow env",
  outputLimit: "limit output",
  audit: "audit as",
  keepAudit: "keep audit",
  taint: "taint",
  keepUntrusted: "keep untrusted inputs",
  taintAsks: "taint asks before",
  useModel: "use model",
  judgeApproves: "let the judge approve clean inputs",
  judgeAutomatically: "judge untrusted inputs automatically",
  judgePrompt: "judge with prompt",
  allowSecret: "allow secret",
  trustFetch: "trust fetch from",
  allowFetch: "allow fetch from",
  allowChanges: "allow changes to",
};

// read and parse @/AGENTS.talk and the files it imports
// gives { definitions: name to tool node, allowedEnv, errors }
async function loadAgentsTalk(root, hostTools) {
  const result = { definitions: Object.create(null), allowedEnv: [], allowedChanges: [], allowedFetch: [], trustedFetch: [], trustWhere: null, allowedSecrets: [], harnessTools: [], untrustedHarnessTools: [], requireClankTalk: false, useModel: null, judge: { model: null, approves: false, automatically: false, prompt: null }, keepAudit: null, taint: null, taintAsks: null, keepUntrustedBytes: null, auditFormat: "text", outputLimit: null, hooks: [], allows: [], errors: [] };
  try {
    await fs.access(nodePath.join(root, AGENTS_TALK));
  } catch (err) {
    return result;
  }

  // first pass: read every file and find the tool names,
  // so in the second pass a tool can call a tool from any file
  const files = [];
  await loadTalkFile(nodePath.join(root, AGENTS_TALK), root, [], files, result.errors);
  const names = Object.keys(hostTools);
  for (const file of files) {
    names.push(...toolNamesIn(file.firstPass.script));
  }

  // second pass: parse with the tool names, and collect the definitions
  for (const file of files) {
    const { script, errors } = parse(file.source, { definitions: true, tools: names });
    for (const e of errors) {
      result.errors.push({ ...e, file: file.name });
    }
    for (const definition of script.definitions) {
      const where = { line: definition.line, column: definition.column, file: file.name };
      if (definition.type === "import") {
        continue;
      }
      if (definition.type === "hook") {
        if (!HOOK_STEPS.includes(definition.name) && !names.includes(definition.name)) {
          result.errors.push({ message: "Unknown step '" + definition.name + "' for a hook. Use " + HOOK_STEPS.join(", ") + ", or a tool name", ...where });
        } else {
          definition.file = file.name;
          result.hooks.push(definition);
        }
        continue;
      }
      // these lines are only allowed in AGENTS.talk, so the settings stay in one file
      const onlyHere = AGENTS_TALK_ONLY[definition.type];
      if (onlyHere !== undefined && file.name !== AGENTS_TALK) {
        result.errors.push({ message: "'" + onlyHere + "' is only allowed in " + AGENTS_TALK, ...where });
        continue;
      }
      if (definition.type.startsWith("allow") && file.name === AGENTS_TALK) {
        result.allows.push({ definition, where });
      }
      // require clank-talk and allow harness tools: for the harness, which blocks its other tools; see src/md/features/harness-tools.md
      if (definition.type === "requireClankTalk") {
        result.requireClankTalk = true;
        continue;
      }
      if (definition.type === "allowHarnessTools") {
        result.harnessTools.push(...definition.names);
        if (definition.untrusted) {
          result.untrustedHarnessTools.push(...definition.names);
        }
        continue;
      }
      if (definition.type === "allowEnv") {
        result.allowedEnv.push(...definition.names);
        continue;
      }
      if (definition.type === "outputLimit") {
        if (result.outputLimit !== null) {
          result.errors.push({ message: "Only one 'limit output' line is allowed", ...where });
        } else {
          result.outputLimit = definition;
        }
        continue;
      }
      if (definition.type === "audit") {
        result.auditFormat = definition.format;
        continue;
      }
      if (definition.type === "keepAudit") {
        if (result.keepAudit !== null) {
          result.errors.push({ message: "Only one 'keep audit' line is allowed", ...where });
        } else {
          result.keepAudit = { days: definition.days, where };
        }
        continue;
      }
      // taint on | off | required, keep untrusted inputs up to <n> MB, and taint asks before; see src/md/features/taint.md
      if (definition.type === "taint") {
        if (result.taint !== null) {
          result.errors.push({ message: "Only one 'taint' line is allowed", ...where });
        } else {
          result.taint = definition.mode;
        }
        continue;
      }
      if (definition.type === "keepUntrusted") {
        if (result.keepUntrustedBytes !== null) {
          result.errors.push({ message: "Only one 'keep untrusted inputs' line is allowed", ...where });
        } else {
          result.keepUntrustedBytes = definition.bytes;
        }
        continue;
      }
      if (definition.type === "taintAsks") {
        if (result.taintAsks !== null) {
          result.errors.push({ message: "Only one 'taint asks before' line is allowed", ...where });
        } else {
          result.taintAsks = definition.asks;
        }
        continue;
      }
      if (definition.type === "useModel") {
        const judging = definition.purpose === "judging";
        if ((judging ? result.judge.model : result.useModel) !== null) {
          result.errors.push({ message: "Only one 'use model ... for " + definition.purpose + "' line is allowed", ...where });
        } else if (judging) {
          result.judge.model = { model: definition.model, secret: definition.secret, where };
        } else {
          result.useModel = { model: definition.model, secret: definition.secret, where };
        }
        continue;
      }
      // the judge lines; see src/md/features/taint.md
      if (definition.type === "judgeApproves" || definition.type === "judgeAutomatically" || definition.type === "judgePrompt") {
        const field = { judgeApproves: "approves", judgeAutomatically: "automatically", judgePrompt: "prompt" }[definition.type];
        if (result.judge[field] !== false && result.judge[field] !== null) {
          result.errors.push({ message: "Only one line of each kind is allowed for the judge", ...where });
        } else {
          result.judge[field] = definition.type === "judgePrompt" ? definition.prompt : true;
        }
        continue;
      }
      if (definition.type === "allowSecret") {
        if (definition.hosts.includes("*")) {
          result.errors.push({ message: "'allow secret' cannot send a secret to every host ('*'). Name the hosts.", ...where });
        } else {
          result.allowedSecrets.push({ name: definition.name, hosts: definition.hosts, run: definition.run, subagents: definition.subagents, where });
        }
        continue;
      }
      if (definition.type === "trustFetch") {
        result.trustedFetch.push(...definition.hosts);
        result.trustWhere = result.trustWhere || where;
        continue;
      }
      if (definition.type === "allowFetch") {
        result.allowedFetch.push(...definition.hosts);
        continue;
      }
      if (definition.type === "allowChanges") {
        for (const shown of definition.paths) {
          // @/ and ./ both start from the root, where AGENTS.talk is
          const rest = shown.startsWith("@/") ? shown.slice(2) : shown;
          const absolute = nodePath.resolve(root, rest);
          // .talk/ holds the audit and the untrusted inputs: no line can open it
          if (isProtectedPath(relativeName(root, absolute) + "/")) {
            result.errors.push({ message: "Cannot allow changes to " + shown + ": .talk/ and talk/ hold the audit and the tools, and no line can open them", ...where });
            continue;
          }
          if (!isInside(absolute, root) || absolute === root) {
            result.errors.push({ message: "Cannot allow changes to " + shown + ": it must be inside the project root", ...where });
            continue;
          }
          result.allowedChanges.push(relativeName(root, absolute));
        }
        continue;
      }
      if (Object.hasOwn(result.definitions, definition.name)) {
        result.errors.push({ message: "Tool '" + definition.name + "' is defined twice", ...where });
      } else if (Object.hasOwn(hostTools, definition.name)) {
        result.errors.push({ message: "Tool '" + definition.name + "' is also a host tool", ...where });
      } else {
        definition.description = commentAbove(file.source, definition.line);
        definition.file = file.name;
        result.definitions[definition.name] = definition;
      }
    }
  }
  return result;
}

// a path relative to the project root, with / on every platform
function relativeName(root, absolute) {
  return nodePath.relative(root, absolute).split(nodePath.sep).join("/");
}

// the names of the tools in a first parse of .talk text, so the second parse knows a tool that is defined later
function toolNamesIn(script) {
  if (!script) {
    return [];
  }
  return script.definitions.filter((definition) => definition.type === "tool").map((definition) => definition.name);
}

// read one .talk file, then the files it imports
// chain is the list of files that import this one, to find import loops
async function loadTalkFile(absolute, root, chain, files, errors) {
  const name = relativeName(root, absolute);
  const source = await fs.readFile(absolute, "utf8");
  const firstPass = parse(source, { definitions: true });
  files.push({ name, source, firstPass });

  for (const definition of firstPass.script.definitions) {
    if (definition.type !== "import") {
      continue;
    }
    const where = { line: definition.line, column: definition.column, file: name };
    const shown = definition.path;

    // ./ and ../ start from the importing file, @/ from the project root
    let base = nodePath.dirname(absolute);
    let rest = definition.path;
    if (rest.startsWith("@/")) {
      base = root;
      rest = rest.slice(2);
    }
    const target = nodePath.resolve(base, rest);

    if (!isInside(target, root)) {
      errors.push({ message: "Cannot import " + shown + ": it is outside the project root", ...where });
      continue;
    }
    if (!target.endsWith(".talk")) {
      errors.push({ message: "Cannot import " + shown + ": only .talk files can be imported", ...where });
      continue;
    }
    if (target === absolute || chain.includes(target)) {
      const loop = chain.concat([absolute, target]).map((file) => relativeName(root, file));
      errors.push({ message: "Import loop: " + loop.join(" -> "), ...where });
      continue;
    }
    // a file imported two times is loaded once
    if (files.some((file) => file.name === relativeName(root, target))) {
      continue;
    }
    let real;
    try {
      real = await fs.realpath(target);
    } catch (err) {
      errors.push({ message: "Cannot import " + shown + ": file not found", ...where });
      continue;
    }
    if (!isInside(real, await fs.realpath(root))) {
      errors.push({ message: "Cannot import " + shown + ": it is outside the project root", ...where });
      continue;
    }
    await loadTalkFile(target, root, chain.concat([absolute]), files, errors);
  }
}

// limit output keeping ...: the print output that the agent sees; the previous output keeps all of it
// a pattern that runs too long is a warning, and the host's own cut still applies
// the most print output text that is kept: "the previous output" (host.js keptOutput) and the input of "limit output"
export const OUTPUT_TEXT_MAX = 5 * 1024 * 1024;

async function limitOutput(execution, state) {
  if (execution.outputLimits.length === 0 || execution.output.length === 0) {
    return;
  }
  let text = execution.output.join("\n");
  // the cut works on at most the last OUTPUT_TEXT_MAX characters; more would cost too much memory
  if (text.length > OUTPUT_TEXT_MAX) {
    text = text.slice(text.length - OUTPUT_TEXT_MAX);
  }
  const total = text.split("\n").length;
  const note = (n) => "... " + n + " lines cut. All " + total + " lines are in: the previous output";
  const keeps = execution.outputLimits.map((limit) => ({ keep: { first: limit.first, last: limit.last, bytes: limit.bytes }, pattern: limit.pattern }));
  try {
    execution.shown = (await keepText(text, keeps, state, execution.outputLimits[0], note)).text;
  } catch (err) {
    // a pattern that fails still cuts: the first, the last and the KB of each line, and the last 400 lines for a
    // pattern alone; the limit never fails open
    const plain = keeps.map(({ keep }) => ({ keep: { ...keep, last: keep.first === null && keep.last === null ? 400 : keep.last }, pattern: null }));
    execution.shown = (await keepText(text, plain, state, execution.outputLimits[0], note)).text;
    execution.warnings.push({ message: "'limit output' could not use its pattern (" + err.message + "), so it kept the last lines", line: 1, column: 1 });
  } finally {
    execution.patterns.stop();
  }
}

function finish(execution, status, errors) {
  execution.status = status;
  execution.errors = errors;
  const result = { status, output: execution.output, errors, warnings: execution.warnings, steps: execution.steps, changes: execution.changes };
  // only when AGENTS.talk or the policy has 'limit output': the print output after that cut
  if (execution.shown !== undefined) {
    result.shown = execution.shown;
  }
  return result;
}

// ----- commands -----

// every command is one step, and so is every pass of a loop,
// so a script that does not end stops at the budget
// this is also where the host sees progress, and where cancel takes effect
function takeStep(node, state) {
  const maxSteps = state.maxSteps;
  const execution = state.execution;
  if (execution.signal.aborted) {
    throw new Cancelled("Cancelled", node);
  }
  execution.steps++;
  if (execution.steps > maxSteps) {
    throw new StepBudget("Step budget of " + maxSteps + " used up", node);
  }
  if (state.onStep !== null) {
    state.onStep({ type: node.type, line: node.line, column: node.column, steps: execution.steps });
  }
}

// gives "break", "continue" or "stop" if one ran, so a loop or "on error" can see it
// "on error" is not a step: it runs only when a command fails
async function runCommands(commands, state) {
  for (const command of commands) {
    if (command.type === "onError") {
      continue;
    }
    takeStep(command, state);
    // the audit names the script line of each step, and the reason from 'because'; a tool's own lines are not the script's
    if (state.file === null) {
      state.auditLine = command.line;
    }
    const savedBecause = state.auditBecause;
    let signal;
    try {
      if (command.because) {
        state.auditBecause = toText(await evaluate(command.because, state));
      }
      try {
        signal = await runCommand(command, state);
      } finally {
        state.auditBecause = savedBecause;
      }
    } catch (caught) {
      let err = caught;
      // a secret in the wrong place: the error points at this command, and names it
      if (err instanceof SecretUse) {
        const word = SECRET_COMMAND_WORDS.includes(command.type) ? command.type : null;
        err = new ScriptError(secretUseMessage(err.secret, err.where || word, state), command);
        err.labels = caught.labels;
      }
      err = scriptErrorFor(err, command, state);
      if (!canHandle(err, state)) {
        throw err;
      }
      // continue: go on with the command after the one that failed
      if (await runHandler(err, state) === "continue") {
        continue;
      }
      err.handledBy = state.handler;
      throw err;
    }
    if (signal === "break" || signal === "continue" || signal === "stop") {
      return signal;
    }
  }
  return null;
}

// commands that a secret error names: "A secret cannot go into write: X"
const SECRET_COMMAND_WORDS = ["write", "append", "replace", "put", "remove", "run", "start", "git", "ask", "find", "wait", "stop"];

// the "on error" block at the top level of a script or tool, or null
function findHandler(commands) {
  for (const command of commands) {
    if (command.type === "onError") {
      return command;
    }
  }
  return null;
}

// can "on error" handle this error? not if there is no handler, the handler is running,
// this handler handled the error before, the host cancelled, or the step budget is used up
function canHandle(err, state) {
  if (!(err instanceof ScriptError) || err instanceof Cancelled || err instanceof StepBudget) {
    return false;
  }
  return state.handler !== null && !state.handling && err.handledBy !== state.handler;
}

// run "on error", with the error in a local variable named error
// gives "continue" or "stop" (the default)
async function runHandler(err, state) {
  const error = Object.create(null);
  // the handler sees no secret's value
  error.message = redact(err.message, state);
  error.line = err.line;
  error.column = err.column;
  if (err.file) {
    error.file = err.file;
  }
  setOwn(state.variables, "error", error);
  state.handling = true;
  try {
    const signal = await runCommands(state.handler.body, state);
    if (signal === "continue") {
      return "continue";
    }
    return "stop";
  } catch (inner) {
    // an error in the handler is not handled by the same handler again
    if (inner instanceof ScriptError) {
      inner.handledBy = state.handler;
    }
    throw inner;
  } finally {
    state.handling = false;
  }
}

// one pass of a loop body; gives true if the loop must stop
async function runLoopBody(node, state) {
  takeStep(node, state);
  const signal = await runCommands(node.body, state);
  return signal === "break";
}

async function runCommand(command, state) {
  if (command.type === "print") {
    // a secret shows as <secret NAME>, and a secret's value in other text too
    const value = showSecrets(await evaluate(command.value, state));
    // print shows a list of lines with their numbers, as an editor does
    if (isListOfLines(value)) {
      state.execution.output.push(redact(value.map((line) => lineLabel(line) + line.text).join("\n"), state));
    } else {
      state.execution.output.push(redact(toText(value), state));
    }
    return;
  }

  if (command.type === "if") {
    const condition = await evaluate(command.condition, state);
    if (isTrue(condition)) {
      // pass break and continue up to the loop
      return await runCommands(command.body, state);
    }
    return await runCommands(command.elseBody, state);
  }

  if (command.type === "break" || command.type === "continue" || command.type === "stop") {
    return command.type;
  }

  // in <target> do ... end: the body runs as is; the parser already gave its replace and find the target
  // break and continue pass up to a loop around it
  if (command.type === "do") {
    return await runCommands(command.body, state);
  }

  if (command.type === "for") {
    const list = await evaluate(command.list, state);
    const items = loopItems(list, command);
    for (let index = 0; index < items.length; index++) {
      setOwn(scopeFor(command.name, state), command.name, items[index]);
      if (command.index !== null) {
        setOwn(scopeFor(command.index, state), command.index, index);
      }
      if (await runLoopBody(command, state)) {
        break;
      }
    }
    return null;
  }

  if (command.type === "repeat") {
    let count = null;
    if (command.kind === "times") {
      count = toNumber(await evaluate(command.value, state), command);
      if (!Number.isInteger(count)) {
        throw new ScriptError("repeat needs a whole number of times, found " + describe(count), command.value);
      }
    }
    let index = 0;
    while (true) {
      if (command.kind === "times" && index >= count) {
        break;
      }
      if (command.kind === "while" && !isTrue(await evaluate(command.value, state))) {
        break;
      }
      if (command.kind === "until" && isTrue(await evaluate(command.value, state))) {
        break;
      }
      if (command.index !== null) {
        setOwn(scopeFor(command.index, state), command.index, index);
      }
      if (await runLoopBody(command, state)) {
        break;
      }
      index++;
    }
    return null;
  }

  if (command.type === "read") {
    state.result = await readText(await evaluate(command.file, state), state, command);
    return null;
  }

  if (command.type === "fetch") {
    await runFetch(command, state);
    return null;
  }
  if (command.type === "wait") {
    await sleep(await durationMs(command.duration, state), state, command);
    return null;
  }
  if (command.type === "waitUntil") {
    await waitUntil(command, state);
    return null;
  }
  if (command.type === "start") {
    state.result = command.subagent ? await startSubagent(command, state) : await startProcess(command, state);
    return null;
  }
  if (command.type === "stopProcess") {
    state.result = await stopProcess(command, state);
    return null;
  }
  if (command.type === "ask") {
    state.result = await askHuman(command, state);
    return null;
  }
  if (command.type === "taintReview") {
    state.result = await taintReview(command, state);
    return null;
  }
  if (command.type === "undo") {
    state.result = await runUndo(command, state);
    return null;
  }
  if (command.type === "git") {
    const output = await runGit(command, state);
    // git prints what it gave back, as help does; it is still the result; see src/md/features/git.md
    if (typeof output === "string" && output.trim() !== "") {
      state.execution.output.push(redact(output, state));
    }
    return null;
  }
  if (command.type === "find") {
    state.result = await evaluate(command, state);
    return null;
  }
  // list prints the entries, one on each line, as git does; the list is the result
  if (command.type === "listFolder") {
    state.result = await evaluate(command, state);
    const shown = state.result.map((file) => (file.folder ? file.path + "/" : file.path));
    state.execution.output.push(shown.length === 0 ? "(empty)" : shown.join("\n"));
    return null;
  }

  if (command.type === "write" || command.type === "append") {
    const value = notNull(await evaluate(command.value, state), "The text to " + command.type + " is null. To make an empty file, write ''", command.value);
    const file = await evaluate(command.file, state);
    const text = toText(await asText(value, state, command));
    const step = changeStep(command.type, file, { text });
    await changeHooks("before", step, state, command);
    await writeText(file, text, command.type === "append", state, command);
    await changeHooks("after", step, state, command);
    return null;
  }

  if (command.type === "replaceLines" || command.type === "removeLines") {
    const range = command.range;
    const file = await evaluate(range.target, state);
    const from = toNumber(await evaluate(range.from, state), command);
    const to = toNumber(await evaluate(range.to, state), command);
    let newText = null;
    if (command.type === "replaceLines") {
      newText = toText(await asText(notNull(await evaluate(command.text, state), "The new text is null. To take lines away, use remove lines", command.text), state, command));
    }
    const step = changeStep(command.type === "replaceLines" ? "replace" : "remove", file, { from, to, text: newText });
    await changeHooks("before", step, state, command);
    state.result = await editLines(file, from, to, newText, state, command);
    await changeHooks("after", step, state, command);
    return null;
  }

  if (command.type === "put") {
    const file = await evaluate(command.file, state);
    const number = toNumber(await evaluate(command.number, state), command);
    const newText = toText(await asText(notNull(await evaluate(command.text, state), "The text to put is null. Give it a value", command.text), state, command));
    // an empty range: before line n puts the text just before it, after line n just after it
    const at = command.where === "before" ? number : number + 1;
    const step = changeStep("put", file, { line: number, where: command.where, text: newText });
    await changeHooks("before", step, state, command);
    state.result = await editLines(file, at, at - 1, newText, state, command, number);
    await changeHooks("after", step, state, command);
    return null;
  }

  if (command.type === "replace") {
    let old = notNull(await evaluate(command.old, state), "The old text is null. Give it a value", command.old);
    if (!(old instanceof Pattern)) {
      old = toText(await asText(old, state, command));
    }
    const replacement = toText(await asText(notNull(await evaluate(command.replacement, state), "The new text is null. To take the match away, replace it with ''", command.replacement), state, command));
    if (old === "") {
      throw new ScriptError("Cannot replace empty text", command);
    }
    if (command.old.dedented) {
      const warning = { message: "The old text is a quoted string on more than one line, so the indent its lines share was removed. For code, use a text block (| lines)", line: command.old.line, column: command.old.column };
      if (state.file) {
        warning.file = state.file;
      }
      state.execution.warnings.push(warning);
    }
    // a text block is one code edit: it must match one place; replace every changes all of them
    const once = command.old.block === true && command.every !== true;
    const target = await evaluate(command.target, state);
    if (target instanceof FileRef) {
      const replacements = await replaceInFile(target, old, replacement, state, command, once);
      state.result = replacements;
      warnIfNoMatch(replacements, old, target.path, state, command);
      return null;
    }
    // a list of files or a glob: every file is checked first, so one bad file writes nothing
    const files = flatFiles(target);
    if (Array.isArray(files) && files.every((file) => file instanceof FileRef)) {
      if (files.length === 0) {
        throw new ScriptError("replace found no files in " + describe(target), command.target);
      }
      for (const file of files) {
        await checkWritable(file, state, command);
      }
      // a text block: at most one place in each file, and one in all, before any file changes
      if (once) {
        let total = 0;
        for (const file of files) {
          const found = (await replaceIn(await readText(file, state, command), old, replacement, state, command)).replacements;
          if (found.length > 1) {
            checkOnce(found, file.path, command);
          }
          total += found.length;
        }
        if (total === 0) {
          checkOnce([], files.length + " files", command);
        }
      }
      const all = [];
      for (const file of files) {
        all.push(...(await replaceInFile(file, old, replacement, state, command)));
      }
      state.result = all;
      warnIfNoMatch(all, old, files.length + " files", state, command);
      return null;
    }
    const isAssignable = command.target.type === "variable" || command.target.type === "property" || command.target.type === "index";
    if (typeof target === "string" && isAssignable) {
      const { text, replacements } = await replaceIn(target, old, replacement, state, command);
      if (once) {
        checkOnce(replacements, "the variable", command);
      }
      await assign(command.target, text, state);
      state.result = replacements;
      warnIfNoMatch(replacements, old, "the variable", state, command);
      return null;
    }
    throw new ScriptError("Expected a file, or a variable with text, found " + describe(target), command);
  }

  if (command.type === "delete") {
    await deleteFile(await evaluate(command.file, state), state, command);
    return null;
  }

  if (command.type === "move") {
    await moveFile(await evaluate(command.from, state), await evaluate(command.to, state), state, command);
    return null;
  }

  if (command.type === "run") {
    state.result = await runProgram(command, state);
    return null;
  }

  if (command.type === "reject") {
    throw new Rejected(toText(await evaluate(command.message, state)), command);
  }

  if (command.type === "help") {
    const list = toolList(state, state.tools);
    let text;
    if (command.word === null) {
      text = helpIndex(list);
    } else {
      text = helpFor(command.word, list);
      if (text === null) {
        throw new ScriptError(noHelp(command.word, list), command);
      }
    }
    state.execution.output.push(text);
    state.result = text;
    return null;
  }

  if (command.type === "set") {
    const value = await evaluate(command.value, state);
    await assign(command.target, value, state);
    return;
  }

  // check <text> [as AGENTS.talk]: the parse errors, as a list of { line, column, message }; empty if it parses
  if (command.type === "check") {
    const value = notNull(await evaluate(command.value, state), "check needs text. Give it a value", command.value);
    // check parses ClankTalk text; a condition is a mistake, since it would parse 'true' and say nothing
    if (typeof value !== "string") {
      throw new ScriptError("check parses ClankTalk text, and found " + describe(value) + ". To test a condition, use if: if @/a.txt exists print 'yes' end", command.value);
    }
    const text = value;
    // the parser needs the tool names: the ones that the session knows, and for AGENTS.talk text, its own tools
    const names = Object.keys(state.tools || {}).concat(Object.keys(state.definitions || {}));
    if (command.agents) {
      names.push(...toolNamesIn(parse(text, { definitions: true }).script));
    }
    const parsed = parse(text, command.agents ? { definitions: true, tools: names } : { tools: names });
    state.result = parsed.errors.map((error) => ({ line: error.line, column: error.column, message: error.message }));
    return;
  }

  // add <value> to <list>: a variable that is not set yet starts as an empty list
  if (command.type === "add") {
    const unset = command.target.type === "variable" && !Object.hasOwn(scopeFor(command.target.name, state), command.target.name);
    const current = unset ? [] : await evaluate(command.target, state);
    if (!Array.isArray(current)) {
      throw new ScriptError("add needs a list, found " + describe(current) + ". To join text, use +", command.target);
    }
    await assign(command.target, [...current, await evaluate(command.value, state)], state);
    return;
  }

  if (command.type === "increment" || command.type === "decrement") {
    // a variable that is not set yet starts at 0, so it is not an unknown variable here
    const unset = command.target.type === "variable" && !Object.hasOwn(scopeFor(command.target.name, state), command.target.name);
    const current = unset ? null : await evaluate(command.target, state);
    let amount = toNumber(await evaluate(command.amount, state), command);
    if (command.type === "decrement") {
      amount = -amount;
    }
    const start = current === null ? 0 : toNumber(current, command);
    await assign(command.target, start + amount, state);
    return;
  }

  if (command.type === "toolCall") {
    const args = [];
    for (const arg of command.args) {
      args.push(await evaluate(arg, state));
    }
    const named = Object.create(null);
    for (const arg of command.named) {
      named[arg.name] = await evaluate(arg.value, state);
    }

    const definition = state.definitions[command.name];
    const host = definition === undefined ? hostTool(state.tools[command.name]) : null;
    const step = toolStep(definition || host, args, named);
    await runHooks("before", [command.name], step, state, command);
    // the audit shows the arguments by position, then by name
    const argText = args.map((arg) => toText(showSecrets(arg))).concat(Object.keys(named).map((name) => name + ": " + toText(showSecrets(named[name])))).join(", ");
    auditStep(state, "tool", command.name, argText);

    if (definition !== undefined) {
      // "within" on the call limits every run inside the tool; the shorter limit wins
      const savedLimit = state.timeLimit;
      if (command.within !== null) {
        state.timeLimit = shorter(state.timeLimit, await durationMs(command.within, state));
      }
      try {
        state.result = await callTool(definition, args, named, command, state);
      } finally {
        state.timeLimit = savedLimit;
      }
      await runHooks("after", [command.name], step, state, command);
      return null;
    }

    // a host tool: its effects first, then the call; see src/md/infrastructure/host.md
    const changed = await hostToolEffects(host, command, step, argText, args, named, state);
    const signal = state.execution.signal;
    try {
      state.result = await host.run({ signal, args, named });
    } catch (err) {
      if (signal.aborted) {
        throw new Cancelled("Cancelled", command);
      }
      const message = "Tool '" + command.name + "' failed: " + err.message;
      // an untrusted tool's error can hold its text, and the agent sees the error, so it goes to the store too
      if (host.untrusted) {
        await noteUntrusted(state, "tool " + command.name + " (error)", message, command);
      }
      throw new ScriptError(message, command);
    } finally {
      if (changed !== null) {
        await recordHostChange(changed, state, command);
      }
    }
    if (host.untrusted) {
      await noteUntrusted(state, "tool " + command.name + (argText !== "" ? " (" + argText + ")" : ""), toText(showSecrets(state.result)));
    }
    await runHooks("after", [command.name], step, state, command);
    return null;
  }

  throw new ScriptError("Unknown command type '" + command.type + "'", command);
}

// ----- expressions -----

async function evaluate(node, state) {
  const type = node.type;

  if (type === "string" || type === "number" || type === "boolean") {
    return node.value;
  }
  if (type === "path") {
    return await resolvePath(node.value, state, node);
  }
  if (type === "line") {
    const target = await evaluate(node.target, state);
    const all = await linesOf(target, state, node);
    const number = toNumber(await evaluate(node.number, state), node.number);
    if (!Number.isInteger(number) || number < 1) {
      throw new ScriptError("Line numbers start at 1, found " + describe(number), node.number);
    }
    if (number > all.length) {
      const where = target instanceof FileRef ? target.path : "the text";
      throw new ScriptError("Line " + number + " is past the end of " + where + " (" + all.length + (all.length === 1 ? " line)" : " lines)"), node);
    }
    return all[number - 1];
  }
  if (type === "lines") {
    const target = await evaluate(node.target, state);
    const all = await linesOf(target, state, node);
    const from = toNumber(await evaluate(node.from, state), node);
    const to = toNumber(await evaluate(node.to, state), node);
    if (!Number.isInteger(from) || from < 1) {
      throw new ScriptError("Line numbers start at 1, found " + describe(from), node.from);
    }
    if (!Number.isInteger(to)) {
      throw new ScriptError("A line number must be a whole number, found " + describe(to), node.to);
    }
    // both ends are included, and a range past the end stops at the last line
    return all.slice(from - 1, Math.max(to, 0));
  }
  if (type === "listFolder") {
    return await listFolder(await evaluate(node.folder, state), node.all, state, node);
  }
  // lines <n> after <line> [of <file or text>]: a line from find knows its file; see src/md/features/language.md
  if (type === "linesNear") {
    const anchor = await evaluate(node.anchor, state);
    if (!(anchor instanceof Line)) {
      throw new ScriptError("lines ... " + node.direction + " needs a line, such as one from find, found " + describe(anchor), node.anchor);
    }
    const count = toNumber(await evaluate(node.count, state), node.count);
    if (!Number.isInteger(count) || count < 0) {
      throw new ScriptError("The count of lines must be a whole number, 0 or more, found " + describe(count), node.count);
    }
    const target = node.target !== null ? await evaluate(node.target, state) : anchor.file;
    if (target === null) {
      throw new ScriptError("This line has no file. Name the text: lines " + count + " " + node.direction + " hit of t", node);
    }
    const all = await linesOf(target, state, node);
    if (node.direction === "after") {
      return all.slice(anchor.number, anchor.number + count);
    }
    return all.slice(Math.max(anchor.number - 1 - count, 0), anchor.number - 1);
  }
  if (type === "read") {
    return await readText(await evaluate(node.file, state), state, node);
  }
  // find as a value: set hits to find 'TODO' in @/src/**/*.js
  if (type === "find") {
    let text = await evaluate(node.text, state);
    if (!(text instanceof Pattern)) {
      text = toText(await asText(text, state, node));
    }
    if (text === "") {
      throw new ScriptError("Cannot find empty text", node);
    }
    const target = await evaluate(node.target, state);
    return await findLines(text, target, state, node);
  }
  // first <n> of <x>, last <n> of <x>: up to n items; text and files give lines
  if (type === "take") {
    const count = toNumber(await evaluate(node.count, state), node.count);
    if (!Number.isInteger(count) || count < 0) {
      throw new ScriptError("'" + node.which + "' needs a whole number of items, found " + describe(count), node.count);
    }
    const target = await evaluate(node.target, state);
    let list;
    if (target instanceof FileRef || typeof target === "string") {
      list = await linesOf(target, state, node);
    } else if (Array.isArray(target)) {
      list = target;
    } else {
      throw new ScriptError("'" + node.which + "' needs a list, a file or text, found " + describe(target), node.target);
    }
    if (node.which === "first") {
      return list.slice(0, count);
    }
    return count === 0 ? [] : list.slice(-count);
  }
  // sorted <list>, unique <list>: a new list, and the old one stays as it was
  if (type === "listOp") {
    const list = await evaluate(node.list, state);
    if (!Array.isArray(list)) {
      throw new ScriptError(node.operation + " needs a list, found " + describe(list), node.list);
    }
    if (node.operation === "sorted") {
      return [...list].sort(compareItems);
    }
    const seen = new Set();
    const kept = [];
    for (const item of list) {
      const key = typeof item + ":" + itemKey(item);
      if (!seen.has(key)) {
        seen.add(key);
        kept.push(item);
      }
    }
    return kept;
  }
  // pattern /<regexp>/flags or pattern '<regexp>': a JavaScript regexp, with the u flag
  if (type === "pattern") {
    const source = toText(await evaluate(node.source, state));
    try {
      return new Pattern(source, node.flags || "");
    } catch (err) {
      throw new ScriptError("Not a valid pattern: " + err.message + patternHint(err.message), node);
    }
  }
  if (type === "null") {
    return null;
  }
  if (type === "template") {
    // 'Bearer ${secret X}' is a secret
    let text = "";
    for (const part of node.parts) {
      if (typeof part === "string") {
        text = text instanceof Secret ? Secret.join(text, part) : text + part;
        continue;
      }
      // a file is its path, as with +
      const value = joinPart(await evaluate(part, state));
      if (text instanceof Secret || value instanceof Secret) {
        text = Secret.join(text, value);
      } else {
        text += toText(value);
      }
    }
    return text;
  }
  if (type === "secret") {
    return secretValue(node, state);
  }
  if (type === "result") {
    return state.result;
  }
  if (type === "variable") {
    const scope = scopeFor(node.name, state);
    if (Object.hasOwn(scope, node.name)) {
      return scope[node.name];
    }
    // a $ global that is not set yet is null, so "if $last is null" works on the first run
    if (node.name.startsWith("$")) {
      return null;
    }
    throw new ScriptError(unknownVariable(node.name, scope, node.pathHint), node);
  }
  if (type === "list") {
    const items = [];
    for (const item of node.items) {
      items.push(await evaluate(item, state));
    }
    return items;
  }
  if (type === "object") {
    // no prototype, so a field named __proto__ is only a field
    const object = Object.create(null);
    for (const field of node.fields) {
      object[field.name] = await evaluate(field.value, state);
    }
    return object;
  }
  if (type === "undoList") {
    return undoList(state);
  }
  // a tool call as a value: set tests to run_tests
  // it runs as the command does, with hooks and the audit, but leaves the result as it was
  if (type === "toolCall") {
    takeStep(node, state);
    const saved = state.result;
    await runCommand(node, state);
    const value = state.result;
    state.result = saved;
    return value;
  }
  // fetch as a value: the status of fetch url as response
  if (type === "fetch") {
    return await runFetch(node, state);
  }
  if (type === "process") {
    const record = state.processes.get(toText(await evaluate(node.name, state)));
    if (record === undefined) {
      return null;
    }
    return await processInfo(record, state);
  }
  if (type === "previousOutput") {
    return state.previousOutput;
  }
  if (type === "processes") {
    return await processList(state);
  }
  // the session: is untrusted while an untrusted input is not approved; see src/md/features/taint.md
  if (type === "session") {
    // taint is for the whole project: the inputs of all sessions that are not approved
    const entries = state.taintMode === "off" ? [] : await untrusted.pendingAll(state.root);
    const session = Object.create(null);
    session.untrusted = entries.length > 0;
    session["untrusted inputs"] = entries.map(({ entry }) => ({ source: entry.source, time: entry.time }));
    return session;
  }
  // the audit: this session's records, oldest first, as plain values
  if (type === "audit") {
    const list = [];
    for (const record of state.audit.records) {
      list.push({ ...record });
    }
    return list;
  }
  if (type === "property") {
    const object = await evaluate(node.object, state);
    if (object instanceof FileRef) {
      return await fileProperty(object, node.name, state, node);
    }
    // text has lines, as a file does
    if (typeof object === "string" && node.name === "lines") {
      return splitLines(object);
    }
    // lines, such as from find, are their own lines: they keep their numbers and files
    if (node.name === "lines" && Array.isArray(object) && object.every((item) => item instanceof Line)) {
      return object;
    }
    // first and last: of a list, or of the lines of text
    if (node.name === "first" || node.name === "last") {
      if (typeof object === "string") {
        return firstOrLast(splitLines(object), node.name);
      }
      if (Array.isArray(object)) {
        return firstOrLast(object, node.name);
      }
    }
    return getProperty(object, node.name, node);
  }
  if (type === "index") {
    const object = await evaluate(node.object, state);
    const index = await evaluate(node.index, state);
    if (object instanceof FileRef) {
      return await fileProperty(object, index, state, node);
    }
    return getProperty(object, index, node);
  }
  if (type === "unary") {
    const value = await evaluate(node.value, state);
    if (value instanceof Secret) {
      throw new SecretUse(value, "'" + node.operator + "'");
    }
    return evaluateUnary(node, value);
  }
  if (type === "check") {
    // the session is untrusted: the parser allows it only on the session
    if (node.operator === "is untrusted" || node.operator === "is not untrusted") {
      const session = await evaluate(node.value, state);
      return node.operator === "is untrusted" ? session.untrusted : !session.untrusted;
    }
    // "x exists" asks if a variable is set, so an unset variable is not an error here
    const isWhether = node.operator === "exists" || node.operator === "does not exist";
    if (isWhether && node.value.type === "variable" && !Object.hasOwn(scopeFor(node.value.name, state), node.value.name)) {
      return node.operator === "does not exist";
    }
    let value = await evaluate(node.value, state);
    if (value instanceof Secret) {
      throw new SecretUse(value, "'" + node.operator + "'");
    }
    if (value instanceof Line) {
      value = value.text;
    }
    if (value instanceof FileRef) {
      if (node.operator === "exists" || node.operator === "does not exist") {
        const exists = await fileExists(value, state, node);
        return node.operator === "exists" ? exists : !exists;
      }
      value = await readText(value, state, node);
    }
    return evaluateCheck(node, value);
  }
  if (type === "conversion") {
    let value = await evaluate(node.value, state);
    if (value instanceof Secret) {
      throw new SecretUse(value, "'as " + node.to + "'");
    }
    // ./data.json as json parses the text of the file; a line parses its text
    if (node.to === "json" && (value instanceof FileRef || value instanceof Line)) {
      value = await asText(value, state, node);
    }
    return convert(node, value);
  }
  if (type === "binary") {
    // "and" and "or" do not evaluate the right side if they do not need it
    if (node.operator === "and") {
      return isTrue(await evaluate(node.left, state)) && isTrue(await evaluate(node.right, state));
    }
    if (node.operator === "or") {
      return isTrue(await evaluate(node.left, state)) || isTrue(await evaluate(node.right, state));
    }
    let left = await evaluate(node.left, state);
    let right = await evaluate(node.right, state);
    // a secret can only be joined with +: a check such as "is" tells something about its value
    if (node.operator !== "+" && (left instanceof Secret || right instanceof Secret)) {
      throw new SecretUse(left instanceof Secret ? left : right, "'" + node.operator + "'");
    }
    // <text> matches pattern /<regexp>/
    if (node.operator === "matches") {
      if (!(right instanceof Pattern)) {
        throw new ScriptError("matches needs a pattern, such as: matches pattern /^v[0-9]+/, found " + describe(right), node.right);
      }
      const answer = await patternJob({ kind: "test", source: right.source, flags: right.flags, text: toText(await asText(left, state, node)) }, state, node);
      return answer.matches;
    }
    // is in a folder: a path check, so it reads no file
    if ((node.operator === "is in" || node.operator === "is not in") && right instanceof FileRef) {
      if (await isFolder(right)) {
        const inside = await inFolder(left, { absolute: right.absolute, root: state.root }, node);
        return node.operator === "is in" ? inside : !inside;
      }
      // with no / at the end and nothing there, the script most likely meant a folder
      if (!(await fs.stat(right.absolute).then(() => true, () => false))) {
        throw new ScriptError("There is no folder " + right.path + ". To check a folder, write it with a / at the end, such as @/" + right.path + "/", node.right);
      }
    }
    // + joins a file as its path, and a line as its text; 'text of' gives a file's text
    if (node.operator === "+") {
      left = joinPart(left);
      right = joinPart(right);
    } else if (TEXT_OPERATORS.includes(node.operator) && !inList(node.operator, left, right)) {
      // other text operators use the text of a file or a line
      left = await asText(left, state, node);
      right = await asText(right, state, node);
    }
    return evaluateBinary(node, left, right);
  }

  throw new ScriptError("Unknown expression type '" + type + "'", node);
}

// the step that a hook for a tool sees: args, named, and each parameter by its name (null if not given)
// ----- host tools; see src/md/infrastructure/host.md -----

// a host tool is a function, or { run, description, params, untrusted, effects }
// effects: { reads: '<param>', changes: '<param>', sends: true }; reads and changes name the parameter with the path
export function hostTool(value) {
  if (typeof value === "function") {
    return { run: value, description: "", params: [], untrusted: false, effects: {} };
  }
  if (value === null || typeof value !== "object") {
    return { run: null, description: "", params: [], untrusted: false, effects: {} };
  }
  return { run: value.run, description: value.description || "", params: value.params || [], untrusted: value.untrusted === true, effects: value.effects || {} };
}

// before a host tool runs: reads is an audit read, changes gets the checks of a write, and sends asks the human
// each time, tainted or not; gives { file, before } for undo, or null
async function hostToolEffects(host, command, step, argText, args, named, state) {
  const reads = await effectFile(host, "reads", step, command, state);
  if (reads !== null) {
    auditRead(state, reads.path);
    giveFile(host, "reads", reads, args, named);
  }
  let changed = null;
  const changes = await effectFile(host, "changes", step, command, state);
  if (changes !== null) {
    giveFile(host, "changes", changes, args, named);
    await checkWritable(changes, state, command);
    const before = await utf8TextOrNull(changes.absolute);
    const real = await realPath(changes, state, command);
    // stale-write check: the file changed after this script read it
    if (real !== null && state.seen.has(real) && before !== undefined && state.seen.get(real) !== before) {
      throw new ScriptError("File changed since it was read: " + changes.path + ". Read it again", command);
    }
    // the write and change hooks see it as a write, so a policy that guards a folder guards it too
    const changeOf = changeStep("write", changes, { text: null, tool: command.name });
    await changeHooks("before", changeOf, state, command);
    changed = { file: changes, before, step: changeOf };
  }
  if (host.effects.sends === true) {
    const question = redact(command.name + (argText !== "" ? " (" + argText + ")" : "") + ": this sends data out of this machine. Allow it?", state);
    const answer = await askState(state, question, ["yes", "no"], null);
    if (answer !== "yes") {
      throw new Rejected("The human did not approve " + command.name + ", which sends data out of this machine", command);
    }
  }
  return changed;
}

// the tool gets the file that the runtime checked, also when the script gave the path as text ('@/a.xlsx')
function giveFile(host, effect, file, args, named) {
  const name = host.effects[effect];
  if (Object.hasOwn(named, name)) {
    named[name] = file;
    return;
  }
  const index = host.params.indexOf(name);
  if (index !== -1 && index < args.length) {
    args[index] = file;
  }
}

// the file in the parameter that an effect names, or null if the effect or the value is not there
async function effectFile(host, effect, step, command, state) {
  const name = host.effects[effect];
  if (typeof name !== "string") {
    return null;
  }
  const value = step[name];
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof FileRef) {
    return value;
  }
  if (typeof value === "string") {
    return await resolvePath(value, state, command);
  }
  throw new ScriptError("Tool '" + command.name + "' needs a file in '" + name + "', found " + describe(value), command);
}

// the text of a file, null if there is no file, or undefined if it is not UTF-8 (undo cannot put back its bytes)
async function utf8TextOrNull(absolute) {
  let bytes;
  try {
    bytes = await fs.readFile(absolute);
  } catch {
    return null;
  }
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) ? text : undefined;
}

// after a host tool that changes a file: the change goes on the undo list and the changed files, as a write does
async function recordHostChange(changed, state, command) {
  const after = await utf8TextOrNull(changed.file.absolute);
  if (changed.before === undefined || after === undefined) {
    state.execution.warnings.push({ message: command.name + " changed " + changed.file.path + ", which is not UTF-8 text, so undo cannot put it back", line: command.line, column: command.column });
    return;
  }
  if (after === changed.before) {
    return;
  }
  state.execution.changes.push({ path: changed.file.path, before: changed.before, after });
  if (after !== null) {
    state.seen.set(await fs.realpath(changed.file.absolute), after);
  }
  await changeHooks("after", changed.step, state, command, "by the host tool " + command.name);
}

function toolStep(definition, args, named) {
  const step = Object.create(null);
  step.args = args;
  step.named = named;
  if (definition !== undefined) {
    definition.params.forEach((param, index) => {
      step[param] = Object.hasOwn(named, param) ? named[param] : index < args.length ? args[index] : null;
    });
  }
  return step;
}

// run a tool from AGENTS.talk, with its own local variables
// gives back the tool's result at the end of the tool
async function callTool(definition, args, named, command, state) {
  if (args.length > definition.params.length) {
    throw new ScriptError("Tool '" + definition.name + "' takes " + definition.params.length + " arguments, found " + args.length, command);
  }
  const locals = Object.create(null);
  for (let index = 0; index < definition.params.length; index++) {
    const param = definition.params[index];
    setOwn(locals, param, index < args.length ? args[index] : null);
  }
  for (const name of Object.keys(named)) {
    if (!definition.params.includes(name)) {
      throw new ScriptError("Tool '" + definition.name + "' has no argument named '" + name + "'", command);
    }
    setOwn(locals, name, named[name]);
  }

  const savedVariables = state.variables;
  const savedResult = state.result;
  const savedHandler = state.handler;
  const savedHandling = state.handling;
  state.variables = locals;
  state.result = null;
  state.handler = findHandler(definition.body);
  state.handling = false;
  const savedFile = state.file;
  state.file = definition.file || AGENTS_TALK;
  // steps inside the tool are "from" the tool in the audit
  const savedFrom = state.auditFrom;
  state.auditFrom = definition.name;
  // inside an untrusted tool, a started program has untrusted output; see processInfo
  const savedUntrustedTool = state.untrustedTool;
  if (definition.untrusted) {
    state.untrustedTool = definition.name;
  }
  // what the tool prints goes to the agent too, so an untrusted tool's print output goes to the store with its result
  const printedFrom = state.execution.output.length;
  try {
    await runCommands(definition.body, state);
    // an untrusted tool's result goes to the store, and makes the session untrusted
    if (definition.untrusted) {
      const shownArgs = args.map((arg) => toText(showSecrets(arg))).concat(Object.keys(named).map((name) => name + ": " + toText(showSecrets(named[name]))));
      const printed = state.execution.output.slice(printedFrom);
      await noteUntrusted(state, "tool " + definition.name + (shownArgs.length > 0 ? " (" + shownArgs.join(", ") + ")" : ""), (printed.length > 0 ? printed.join("\n") + "\n" : "") + toText(showSecrets(state.result)));
    }
    return state.result;
  } catch (err) {
    // an untrusted tool's error can hold its text, and the agent sees the error, so it goes to the store too
    if (definition.untrusted && err instanceof ScriptError && !(err instanceof Cancelled) && !(err instanceof StepBudget)) {
      const printed = state.execution.output.slice(printedFrom);
      await noteUntrusted(state, "tool " + definition.name + " (error)", (printed.length > 0 ? printed.join("\n") + "\n" : "") + err.message, command);
    }
    // a reject points at the tool call, so the agent sees where
    if (err instanceof Rejected) {
      throw new Rejected(err.message, command);
    }
    // an error inside the tool points into AGENTS.talk
    if (err instanceof ScriptError && !err.file) {
      err.file = definition.file || AGENTS_TALK;
    }
    throw err;
  } finally {
    state.variables = savedVariables;
    state.result = savedResult;
    state.handler = savedHandler;
    state.file = savedFile;
    state.handling = savedHandling;
    state.auditFrom = savedFrom;
    state.untrustedTool = savedUntrustedTool;
  }
}

// ----- run -----

// the smaller of two time limits; null means no limit
function shorter(a, b) {
  if (a === null) {
    return b;
  }
  if (b === null) {
    return a;
  }
  return Math.min(a, b);
}

async function durationMs(node, state) {
  return toNumber(await evaluate(node.value, state), node) * node.ms;
}

// start a program with no shell, and wait for it
// gives { code, output }: the exit code, and stdout and stderr together, in the order they came
async function runProgram(command, state) {
  if (command.subagent) {
    return await runSubagentCommand(command, state);
  }
  const { program, args } = await programAndArgs(command, state);
  const step = Object.create(null);
  step.program = program;
  step.args = args;
  const sandbox = await sandboxValues(command, state);
  step.sandbox = sandbox;
  step.secrets = [...command.secrets];
  checkDenied("run", state, command);
  checkSandboxRequired("run", sandbox, state, command);
  await runHooks("before", ["run"], step, state, command);
  if (sandbox === null || sandbox.network) {
    await askUntrusted(state, "network runs", "Run " + [program, ...args].join(" ") + (sandbox === null ? " with no sandbox" : " with network"), command);
  }

  const env = programEnv(command, state);
  const found = await resolveProgram(program, env, state, command);
  let limit = state.timeLimit;
  if (command.within !== null) {
    limit = shorter(limit, await durationMs(command.within, state));
  }

  let result;
  const started = Date.now();
  if (sandbox === null) {
    // a program with no sandbox can change .talk/: keep hashes and the end of the audit, and check after the run
    const before = await untrusted.snapshot(state.root);
    try {
      result = await spawnProgram(found, args, state.cwd, env, limit, state, command);
    } finally {
      await checkTalkFolder(state, before, program, command);
    }
  } else {
    const wrapped = await sandboxCommand(found, args, sandbox, env, false, state, command);
    try {
      result = await spawnProgram(wrapped.program, wrapped.args, state.cwd, wrapped.env, limit, state, command);
    } finally {
      await removeSandboxTmp(wrapped.tmp, state);
    }
  }

  // the output can hold a secret's value, for example from "env"
  result.output = redact(result.output, state);
  const cut = command.keeping ? await keepRunOutput(result, command.keeping, state, command) : 0;
  auditStep(state, "run", [program, ...args].join(" "), sandboxText(sandbox) + "code " + result.code + ", " + ((Date.now() - started) / 1000).toFixed(1) + " s" + (cut > 0 ? ", " + cut + " lines cut" : "") + secretNote(command.secrets));

  // after hooks see the result
  state.result = result;
  await runHooks("after", ["run"], step, state, command);
  return result;
}
// run ... keeping: cut the program's output to the lines the tool wants; one line takes the place of the cut lines
// the result's full keeps all of it; gives the number of lines cut; see src/md/features/sandbox-run.md
async function keepRunOutput(result, keeping, state, command) {
  result.full = result.output;
  const count = async (node, unit) => {
    if (node === null) {
      return null;
    }
    const n = toNumber(await evaluate(node, state), node);
    if (!Number.isInteger(n) || n < 0) {
      throw new ScriptError("keeping needs a whole number of " + unit + ", 0 or more, found " + n, node);
    }
    return n;
  };
  const kb = await count(keeping.bytes, "KB");
  const keep = { first: await count(keeping.first, "lines"), last: await count(keeping.last, "lines"), matches: null, bytes: kb === null ? null : kb * 1024 };
  const other = keeping.pattern !== null ? " other" : "";
  const cut = await keepText(result.output, [{ keep, pattern: keeping.pattern }], state, command, (n) => "... " + n + other + " lines cut (all lines: the result's full) ...");
  result.output = cut.text;
  return cut.cut;
}

// cut a text with one or more keeps, each one on what the one before it kept: [{ keep, pattern }]
// pattern is null or a node that gives a pattern; with a pattern, one note goes at the end, else one at each gap
// a text that ends with a line break still does
async function keepText(text, keeps, state, node, note) {
  const ends = text.endsWith("\n");
  let items = (ends ? text.slice(0, -1) : text).split("\n").map((line, index) => ({ index, text: line }));
  const total = items.length;
  let atEnd = false;
  for (const { keep, pattern } of keeps) {
    let matches = null;
    if (pattern !== null) {
      const value = await evaluate(pattern, state);
      if (!(value instanceof Pattern)) {
        throw new ScriptError("keeping lines matching needs a pattern, such as: keeping lines matching pattern /FAIL/, found " + describe(value), pattern);
      }
      matches = (await patternJob({ kind: "lines", source: value.source, flags: value.flags, lines: items.map((item) => item.text) }, state, node)).indexes;
      atEnd = true;
    }
    items = keepItems(items, { ...keep, matches });
  }
  const kept = withNotes(items, total, note, atEnd);
  return { text: kept.lines.join("\n") + (ends && kept.lines.length > 0 ? "\n" : ""), cut: kept.cut };
}

// the sandbox's temp folder goes after the program; a program can leave a file there that cannot be removed,
// and that is a warning, not a failed run
async function removeSandboxTmp(tmp, state) {
  try {
    await fs.rm(tmp, { recursive: true, force: true });
  } catch (err) {
    state.execution.warnings.push({ message: "Could not remove the sandbox's temp folder (" + (err.code || "error") + "). Remove it later: " + tmp, line: 1, column: 1 });
  }
}

// the program and arguments of run or start
//   run 'mvn test': one text, split on spaces
//   run 'mvn' with 'test', name: each argument as it is
async function programAndArgs(command, state) {
  let program;
  let args = [];
  // for each argument: is it written out as text in the .talk file?
  let written = [];
  if (command.args === null && command.program.type === "template") {
    const words = await templateWords(command.program, state);
    program = words.length > 0 ? words[0].text : "";
    args = words.slice(1).map((word) => word.text);
    written = words.slice(1).map((word) => word.written);
  } else if (command.args === null) {
    const value = await evaluate(command.program, state);
    const parts = toText(value).split(/\s+/).filter((part) => part !== "");
    program = parts[0];
    args = parts.slice(1);
    written = args.map(() => command.program.type === "string");
  } else {
    program = toText(await evaluate(command.program, state));
    for (const arg of command.args) {
      const value = await evaluate(arg, state);
      // a list gives one argument for each item, such as each file of ./src/*.js
      const items = Array.isArray(value) ? value : [value];
      for (const item of items) {
        if (item === null || item === undefined) {
          throw new ScriptError("An argument to " + describe(program) + " is null. Give the tool a value for it", arg);
        }
        args.push(argText(item, state));
        // an item of a list is not written out, even if the list is
        written.push(items === value ? false : startsWritten(arg));
      }
    }
  }
  if (!program) {
    throw new ScriptError("Nothing to run", command);
  }
  if (!programWritten(command)) {
    const word = command.type === "start" ? "start" : "run";
    throw new ScriptError("The program for " + word + " must be written out in " + (state.file || AGENTS_TALK) + ", not given by the agent. Write it in the tool, such as: " + word + " 'npm' with name", command.program);
  }
  checkOptionArgs(args, written, command, state);
  return { program, args };
}

// run 'npm test ${name}': only the written-out text splits on spaces, so each ${} is one whole argument,
// or a part of one, as in --name=${p}; a word is written out if it starts with written-out text
async function templateWords(node, state) {
  const words = [];
  let word = null;
  const add = (text, written) => {
    if (word === null) {
      word = { text: "", written };
    }
    word.text += text;
  };
  for (const part of node.parts) {
    if (typeof part !== "string") {
      const value = await evaluate(part, state);
      if (value === null || value === undefined) {
        throw new ScriptError("A value in the run text is null. Give the tool a value for it", part);
      }
      add(argText(value, state), false);
      continue;
    }
    for (const piece of part.split(/(\s+)/)) {
      if (/^\s+$/.test(piece)) {
        if (word !== null) {
          words.push(word);
        }
        word = null;
      } else if (piece !== "") {
        add(piece, true);
      }
    }
  }
  if (word !== null) {
    words.push(word);
  }
  return words;
}

// a file is its path from the folder where the program runs, such as ./src/a.js or ../b.txt
// so it never starts with "-"; the path was checked to be inside the project when the file value was made
function argText(value, state) {
  if (value instanceof FileRef) {
    const relative = relativeName(state.cwd, value.absolute);
    if (relative === "") {
      return ".";
    }
    return relative.startsWith("../") || relative === ".." ? relative : "./" + relative;
  }
  return toText(value);
}

// the program is written out in the .talk file, so the agent cannot pick it: run 'npm' with x, or run 'npm test ${x}',
// where the program is a whole word before the first ${}
function programWritten(command) {
  const node = command.program;
  if (node.type === "string") {
    return true;
  }
  return command.args === null && node.type === "template" && typeof node.parts[0] === "string" && /^\s*\S+\s/.test(node.parts[0]);
}

// the start of the argument is written out in the .talk file: 'x', 'x' + name, or 'x${name}'
// then the agent's value cannot be the start, so it cannot make an option
function startsWritten(arg) {
  if (arg.type === "string") {
    return arg.value !== "";
  }
  if (arg.type === "binary" && arg.operator === "+") {
    return startsWritten(arg.left);
  }
  if (arg.type === "template") {
    return typeof arg.parts[0] === "string" && arg.parts[0] !== "";
  }
  return false;
}

// an argument that is not written out in the .talk file must not start with "-",
// or a program can read an agent's value as an option, such as --rulesdir=./evil
// a written-out "--" ends the options, so the arguments after it are not checked
function checkOptionArgs(args, written, node, state) {
  for (let index = 0; index < args.length; index++) {
    if (written[index] && args[index] === "--") {
      return;
    }
    if (!written[index] && args[index].startsWith("-")) {
      throw new ScriptError("The argument " + describe(args[index]) + " starts with '-', and it is not written out in " + (state.file || AGENTS_TALK) + ". A program can read it as an option. If the program takes '--' to end its options, put '--' before the value in the tool", node);
    }
  }
}

// a bare program name is found through PATH; the file found must be outside the project,
// or the agent can put its own program there; the full path runs, so nothing changes between check and run
// a relative or empty PATH entry is the current folder, so it counts as inside the project
async function resolveProgram(program, env, state, node) {
  if (program.includes("/") || program.includes("\\") || process.platform === "win32" || env.PATH === undefined) {
    return program;
  }
  for (const entry of env.PATH.split(nodePath.delimiter)) {
    const candidate = nodePath.join(nodePath.resolve(state.cwd, entry === "" ? "." : entry), program);
    try {
      if (!(await fs.stat(candidate)).isFile()) {
        continue;
      }
      await fs.access(candidate, fs.constants.X_OK);
    } catch (err) {
      continue;
    }
    const real = await fs.realpath(candidate);
    if (isInside(candidate, state.root) || isInside(real, state.root)) {
      const shown = relativeName(state.root, candidate);
      throw new ScriptError("run '" + program + "' found " + shown + " inside the project, and the agent can change files there. Write the path in the tool to run it on purpose: run './" + shown + "'", node);
    }
    return candidate;
  }
  return program;
}

// only the environment variables that AGENTS.talk allows
function allowedEnvFor(state) {
  const env = {};
  for (const name of state.allowedEnv) {
    if (process.env[name] !== undefined) {
      env[name] = process.env[name];
    }
  }
  return env;
}

// git <operation>: a hardened git; see src/md/features/git.md and src/js/git.js
// the result is git's output as text; a failed git call is a script error
async function runGit(command, state) {
  const step = Object.create(null);
  step.operation = command.operation;
  const args = await gitArgs(command, state, step);
  step.args = args;
  if (command.operation === "push") {
    checkDenied("git push", state, command);
  } else if (GIT_WRITES.includes(command.operation)) {
    checkDenied("writes", state, command);
  }
  // a pull uses the network
  if (command.operation === "pull") {
    checkDenied("fetch", state, command);
  }
  await runHooks("before", ["git"], step, state, command);
  // in an untrusted session, a commit and a push ask the human
  if (command.operation === "commit") {
    await askUntrusted(state, "commit", "Commit '" + (step.message === undefined ? "" : step.message) + "'", command);
  } else if (command.operation === "push") {
    await askUntrusted(state, "push", step.tag === undefined ? "Push to origin" : "Push tag " + step.tag + " to origin", command);
  }

  const env = gitEnv(process.env);
  // the repo config can make git run programs; if it does, git does not run
  const config = await spawnProgram("git", [...guardArgs(), "config", "list", "--show-scope"], state.root, env, state.timeLimit, state, command);
  const refused = unsafeConfig(config.output);
  if (refused.length > 0) {
    throw new ScriptError(
      "Git is turned off here, because the repo config can run programs: " + refused.join(", ") + "\n" +
      "A human must remove these settings from .git/config.",
      command,
    );
  }

  if (command.operation === "rebase") {
    await checkRebase(step.branch, state, env, command);
  }
  if (command.operation === "push" || command.operation === "pull") {
    await checkPushRemote(state, env, command, command.operation === "pull");
  }
  // pull: the current branch; remember where it was, to find the changed files after
  let pulledFrom = null;
  if (command.operation === "pull") {
    const current = await gitCheck(["branch", "--show-current"], state, env, command);
    if (current === "") {
      throw new ScriptError("git pull needs a branch. Switch to a branch first", command);
    }
    step.branch = current;
    args.push(current);
    pulledFrom = await gitCheck(["rev-parse", "HEAD"], state, env, command);
  }
  // pull: fetch first, so the change hooks can see what the pull will change; then merge without the network
  let runArgs = args;
  if (command.operation === "pull") {
    const fetched = await spawnProgram("git", [...guardArgs(true), "fetch", "--no-recurse-submodules", "origin", step.branch], state.root, gitEnv(process.env, true), state.timeLimit, state, command);
    if (fetched.code !== 0) {
      throw new ScriptError("git pull failed: " + fetched.output.trim(), command);
    }
    runArgs = ["merge", "--ff-only", "FETCH_HEAD"];
  }
  // a git write that changes files runs the change hooks for each of them first, so a rule for a folder covers git too
  await gitChangeHooks(command, step, state, env);
  // restore: the change hooks, and the text before, for undo
  const restored = [];
  if (command.operation === "restore") {
    for (const file of step.refs) {
      const change = changeStep("restore", file, {});
      await changeHooks("before", change, state, command);
      restored.push({ file, change, before: await currentText(file.path, state) });
    }
    delete step.refs;
  }

  // commit adds the named files first, so new files can be committed too;
  // the commit then has only those files, even if other files are staged
  // a file that is gone (moved or removed) is not added: the commit still names it, so git commits the change
  if (command.operation === "commit") {
    const present = [];
    for (const path of step.files) {
      if (await fs.access(nodePath.resolve(state.root, path)).then(() => true, () => false)) {
        present.push(path);
      }
    }
    if (present.length > 0) {
      const add = await spawnProgram("git", [...guardArgs(), "add", "--", ...present], state.root, env, state.timeLimit, state, command);
      if (add.code !== 0) {
        throw new ScriptError("git add failed: " + add.output.trim(), command);
      }
    }
  }

  // with the root in a subfolder of a repo, git output covers only the root's files, as reads do
  if (["status", "log", "show"].includes(command.operation) || (command.operation === "diff" && command.value === null)) {
    const prefix = await gitCheck(["rev-parse", "--show-prefix"], state, env, command);
    if (prefix !== "") {
      args.push(...(args.includes("--") ? ["."] : ["--", "."]));
    }
  }

  const forPush = command.operation === "push";
  const result = await spawnProgram("git", [...guardArgs(forPush), ...runArgs], state.root, gitEnv(process.env, forPush), state.timeLimit, state, command);
  if (result.code !== 0 && command.operation === "rebase") {
    await stopRebase(state, env, command);
  }
  if (result.code !== 0) {
    throw new ScriptError("git " + command.operation + " failed: " + result.output.trim(), command);
  }
  // the audit shows git as the script wrote it; the JSON audit keeps the full arguments
  const shown = gitShown(command.operation, step, args);
  auditStep(state, "git", shown.target, shown.details, { args: args.join(" ") });
  // restore: each file is a change, so undo can take it back; the script saw the new text, so a later write is not stale
  for (const { file, change, before } of restored) {
    const after = await currentText(file.path, state);
    if (after !== before) {
      state.execution.changes.push({ path: file.path, before, after });
    }
    if (after !== null) {
      state.seen.set(await fs.realpath(file.absolute), after);
    }
    await changeHooks("after", change, state, command, after === before ? "no change" : "put back as in the last commit");
  }
  // pull: code from other people; the changed files go to the store, so the project is untrusted
  if (pulledFrom !== null) {
    const changed = await gitCheck(["diff", "--name-only", pulledFrom, "HEAD"], state, env, command);
    if (changed !== "") {
      await noteUntrusted(state, "git pull origin " + step.branch, "The pull changed these files:\n" + changed, command);
    }
  }
  // a .env file in git must not show in a diff either, since scripts cannot read it
  if (command.operation === "diff" || command.operation === "show") {
    result.output = hideSecretDiffs(result.output);
  }
  state.result = result.output;
  await runHooks("after", ["git"], step, state, command);
  return result.output;
}

// in a diff, replace the part for each .env or .env.* file with one line
// a header can be "diff --git a/x b/x", "diff --cc x" for a merge, and git quotes a path with odd characters;
// each word of the header is checked, so a path with spaces or quotes is still found
function hideSecretDiffs(text) {
  const parts = text.split(/(?=^diff --(?:git|cc|combined) )/m);
  return parts.map((part) => {
    if (!/^diff --(?:git|cc|combined) /.test(part)) {
      return part;
    }
    const header = part.split("\n", 1)[0];
    const words = header.replaceAll('"', "").split(" ").slice(2);
    if (words.some((word) => isSecretFile(word.replace(/^[ab]\//, "")))) {
      return header + "\n(a .env file: not shown, since it holds secrets)\n";
    }
    return part;
  }).join("");
}

// the branch name of a git command; a bare word that is no variable is a branch name with no quotes
async function branchName(command, state) {
  const node = command.value;
  if (node.type === "variable" && !node.name.startsWith("$") && !Object.hasOwn(scopeFor(node.name, state), node.name)) {
    throw new ScriptError("A branch name is text, in quotes: " + gitExample(command, "'" + node.name + "'"), node);
  }
  return toText(notNull(await evaluate(node, state), "The branch name is null. Give it a value", node));
}

// the git command written out, for an error
function gitExample(command, name) {
  if (command.operation === "switch") {
    return "git switch to " + (command.create ? "new branch " : "") + name;
  }
  if (command.operation === "delete") {
    return "git delete branch " + name;
  }
  if (command.operation === "rebase") {
    return "git rebase onto " + name;
  }
  return "git merge " + name;
}

// the files that a git write will change, before it runs: the change hooks run for each of them, and a reject
// stops git before it changes anything; see src/md/features/git.md
async function gitChangeHooks(command, step, state, env) {
  const op = command.operation;
  // paths relative to the root, with no renames, so a rename shows both the old and the new path
  const paths = async (args) => {
    const result = await spawnProgram("git", [...guardArgs(), ...args], state.root, env, state.timeLimit, state, command);
    if (result.code !== 0) {
      throw new ScriptError("git " + op + " failed: " + result.output.trim(), command);
    }
    return result.output.split("\n").filter((line) => line !== "");
  };
  const diff = (...range) => paths(["diff", "--name-only", "--no-renames", "--relative", ...range, "--"]);
  let changed = [];
  if (op === "move") {
    changed = [step.from, step.to];
  } else if (op === "switch" && !command.create) {
    // a branch that is only on origin: git switch makes it from origin/<name>
    const local = await spawnProgram("git", [...guardArgs(), "rev-parse", "--verify", "--quiet", "refs/heads/" + step.branch], state.root, env, state.timeLimit, state, command);
    changed = await diff("HEAD", local.code === 0 ? step.branch : "origin/" + step.branch);
  } else if (op === "merge") {
    changed = await diff("HEAD", step.branch);
  } else if (op === "rebase") {
    changed = await diff("HEAD..." + step.branch);
  } else if (op === "pull") {
    changed = await diff("HEAD", "FETCH_HEAD");
  } else if (op === "stash" && command.pop) {
    changed = await paths(["stash", "show", "--name-only", "--no-renames", "--relative"]);
  } else if (op === "stash") {
    changed = await diff("HEAD");
  }
  for (const path of changed) {
    const file = new FileRef(nodePath.resolve(state.root, path), state.root);
    const fields = op === "move" ? { from: step.from, to: step.to } : {};
    await changeHooks("before", changeStep(op === "move" ? "move" : "git " + op, file, fields), state, command);
  }
}

// git with the hardened arguments, for the checks around an operation
async function gitCheck(args, state, env, command) {
  const result = await spawnProgram("git", [...guardArgs(), ...args], state.root, env, state.timeLimit, state, command);
  return result.output.trimEnd();
}

// a remote that is a folder runs its own hooks on a push, and the hardened settings do not reach it;
// a folder inside the project can hold hooks that the agent wrote, so a push to it is refused
// a folder outside the project is the human's; see src/md/features/git.md
// a pull checks the fetch URLs: git runs the remote's upload hooks on a local folder too
async function checkPushRemote(state, env, command, forPull = false) {
  const result = await spawnProgram("git", [...guardArgs(), "remote", "get-url", ...(forPull ? [] : ["--push"]), "--all", "origin"], state.root, env, state.timeLimit, state, command);
  if (result.code !== 0) {
    return;
  }
  const realRoot = await fs.realpath(state.root);
  for (const url of result.output.split("\n").map((line) => line.trim()).filter((line) => line !== "")) {
    const folder = localRemotePath(url);
    if (folder === null) {
      continue;
    }
    const absolute = nodePath.resolve(state.root, folder);
    const real = await fs.realpath(absolute).catch(() => absolute);
    if (isInside(absolute, state.root) || isInside(real, realRoot)) {
      throw new ScriptError((forPull ? "git pull cannot use" : "git push cannot go to") + " a remote inside the project, because it runs that repo's hooks, and a script can write them: " + url, command);
    }
  }
}

// the folder of a remote URL, or null for a network URL: file:///x, /x, ./x and ../x are folders;
// https://h/x, ssh://h/x and the scp form host:x are not (a ":" before the first "/")
function localRemotePath(url) {
  if (url.startsWith("file://")) {
    return decodeURIComponent(new URL(url).pathname);
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    return null;
  }
  const colon = url.indexOf(":");
  const slash = url.indexOf("/");
  if (colon !== -1 && (slash === -1 || colon < slash)) {
    return null;
  }
  return url;
}

// a rebase rewrites the branch's commits, so it runs only on a clean branch that is not on a remote
async function checkRebase(onto, state, env, command) {
  const current = await gitCheck(["branch", "--show-current"], state, env, command);
  if (current === "") {
    throw new ScriptError("git rebase needs a branch. Switch to a branch first", command);
  }
  if (current === onto) {
    throw new ScriptError("git rebase cannot put " + current + " onto itself. Switch to the branch to move first", command);
  }
  const changes = await gitCheck(["status", "--porcelain", "--untracked-files=no"], state, env, command);
  if (changes !== "") {
    throw new ScriptError("git rebase needs a clean branch. Commit the changes first:\n" + changes, command);
  }
  const all = await gitCheck(["rev-list", "--count", onto + "..HEAD"], state, env, command);
  const local = await gitCheck(["rev-list", "--count", onto + "..HEAD", "--not", "--remotes"], state, env, command);
  if (all !== local) {
    throw new ScriptError("git rebase refused: " + current + " has commits on a remote, and a rebase rewrites them. A human must do this rebase", command);
  }
}

// after a failed rebase: find the files in conflict, then put the branch back as it was
async function stopRebase(state, env, command) {
  const conflicts = await gitCheck(["diff", "--name-only", "--diff-filter=U"], state, env, command);
  await gitCheck(["rebase", "--abort"], state, env, command);
  if (conflicts !== "") {
    throw new ScriptError("git rebase stopped: these files have conflicts, so the branch is as it was:\n" + conflicts + "\nMerge by hand, or ask the human", command);
  }
}

// the fixed git arguments for each operation, with the checked values from the script
// values for hooks go on the step: files and message for commit, branch for switch
async function gitArgs(command, state, step) {
  const op = command.operation;
  if (op === "status") {
    return ["status", "--short", "--branch"];
  }
  if (op === "branch") {
    return ["branch", "--show-current"];
  }
  if (op === "branches") {
    return ["branch", "--list"];
  }
  if (op === "switch") {
    const name = await branchName(command, state);
    if (!isSafeBranchName(name)) {
      throw new ScriptError("Not a safe branch name: " + describe(name) + ". Use letters, digits, -, _, / and .", command.value);
    }
    step.branch = name;
    if (command.create) {
      return ["switch", "--create", name];
    }
    return ["switch", name];
  }
  // only a branch that is merged: --delete, never --force
  if (op === "delete") {
    const name = await branchName(command, state);
    if (!isSafeBranchName(name)) {
      throw new ScriptError("Not a safe branch name: " + describe(name) + ". Use letters, digits, -, _, / and .", command.value);
    }
    step.branch = name;
    return ["branch", "--delete", name];
  }
  // the current branch, to a branch with the same name on origin; never force
  // git push tag <name>: one tag that is here, to origin; never force, so a tag on origin is never moved
  if (op === "push") {
    if (command.tag) {
      const name = toText(notNull(await evaluate(command.tag, state), "The tag name is null. Give it a value", command.tag));
      if (!isSafeBranchName(name)) {
        throw new ScriptError("Not a safe tag name: " + describe(name) + ". Use letters, digits, -, _, / and .", command.tag);
      }
      step.tag = name;
      return ["push", "--no-verify", "origin", "refs/tags/" + name + ":refs/tags/" + name];
    }
    return ["push", "--no-verify", "origin", "HEAD"];
  }
  // git mv, so the history follows the file: one file, with the checks of a write for both paths
  // it is not in the undo list, as git switch and git commit are not
  if (op === "move") {
    const from = await evaluate(command.value, state);
    const to = await evaluate(command.to, state);
    await checkWritable(from, state, command.value);
    await checkWritable(to, state, command.to);
    if ((await realPath(to, state, command.to)) !== null) {
      throw new ScriptError("Cannot move " + from.path + " to " + to.path + ": that file is already there. git move does not replace files", command.to);
    }
    step.from = from.path;
    step.to = to.path;
    // git mv needs the folder of the new path
    await makeParentFolders(to, state, command.to);
    return ["mv", "--", from.path, to.path];
  }
  // the current branch onto another; runGit checks it first, and stops it on a conflict
  if (op === "rebase") {
    const name = await branchName(command, state);
    if (!isSafeBranchName(name)) {
      throw new ScriptError("Not a safe branch name: " + describe(name) + ". Use letters, digits, -, _, / and .", command.value);
    }
    step.branch = name;
    return ["rebase", "--no-autosquash", "--no-autostash", name];
  }
  // fast-forward only: a merge never makes a commit, so it needs no message and cannot conflict
  if (op === "merge") {
    const name = await branchName(command, state);
    if (!isSafeBranchName(name)) {
      throw new ScriptError("Not a safe branch name: " + describe(name) + ". Use letters, digits, -, _, / and .", command.value);
    }
    step.branch = name;
    return ["merge", "--ff-only", name];
  }
  if (op === "commit") {
    const value = flatFiles(await evaluate(command.value, state));
    const files = Array.isArray(value) ? value : [value];
    if (files.length === 0) {
      throw new ScriptError("git commit found no files to commit", command.value);
    }
    const paths = [];
    for (const file of files) {
      if (!(file instanceof FileRef)) {
        throw new ScriptError("git commit needs a file or a list of files, found " + describe(file), command.value);
      }
      // the agent cannot change its own tools or audit, so it cannot commit them either; see src/md/features/git.md
      if (await isProtected(file, state, command.value)) {
        throw new ScriptError("A script cannot commit .talk files or the @/talk folder: " + file.path + ". A human commits them", command.value);
      }
      // a hidden file, such as .env, often holds secrets
      const hidden = await isHidden(file, state, command.value);
      if (hidden !== null) {
        throw new ScriptError(
          "A script cannot commit hidden files or folders (a name that starts with .): " + file.path + "\n" +
          "To allow this, a human can add this line to AGENTS.talk:\n" +
          "  " + allowLineFor(hidden),
          command.value,
        );
      }
      // a folder can hold hidden files, such as .env, so commit takes files only
      const stats = await fs.stat(file.absolute).catch(() => null);
      if (stats !== null && stats.isDirectory()) {
        throw new ScriptError("git commit needs files, not a folder: " + file.path + ". Name the files, for example with a glob: @/" + file.path + "/**/*", command.value);
      }
      paths.push(file.path);
    }
    const given = await evaluate(command.message, state);
    if (given === null || given === undefined) {
      throw new ScriptError("The commit message is null. Give the commit a message", command.message);
    }
    const message = toText(given);
    if (message.trim() === "") {
      throw new ScriptError("A commit needs a message", command.message);
    }
    step.files = paths;
    step.message = message;
    return ["commit", "--no-verify", "--no-gpg-sign", "--message=" + message, "--", ...paths];
  }
  if (op === "log") {
    let count = 15;
    if (command.value !== null) {
      count = toNumber(await evaluate(command.value, state), command.value);
      if (!Number.isInteger(count) || count < 1) {
        throw new ScriptError("git log needs a whole number above 0, found " + count, command.value);
      }
    }
    return ["log", "--oneline", "--no-show-signature", "-n", String(count)];
  }
  if (op === "show") {
    const name = toText(await evaluate(command.value, state));
    if (!isSafeCommitName(name)) {
      throw new ScriptError("Not a safe commit name: " + describe(name) + ". Use a commit id, a branch name, or HEAD~1", command.value);
    }
    // ^{commit}: only a commit, never a blob, so a blob id cannot show a .env file
    return ["show", "--no-ext-diff", "--no-textconv", "--no-show-signature", name + "^{commit}", "--"];
  }
  if (op === "diff") {
    const args = ["diff", "--no-ext-diff", "--no-textconv", "--"];
    if (command.value !== null) {
      const value = flatFiles(await evaluate(command.value, state));
      const files = Array.isArray(value) ? value : [value];
      // an empty list would give the diff of everything, which is a surprise
      if (files.length === 0) {
        throw new ScriptError("git diff found no files to show", command.value);
      }
      for (const file of files) {
        if (!(file instanceof FileRef)) {
          throw new ScriptError("git diff needs a file or a list of files, found " + describe(file), command.value);
        }
        if (isSecretFile(file.path)) {
          throw new ScriptError("A script cannot read .env files, because they hold secrets: " + file.path, command.value);
        }
        args.push(file.path);
      }
    }
    return args;
  }
  // stash: tracked files only, so untracked files (such as .talk/) stay where they are; see src/md/features/git.md
  if (op === "stash") {
    return command.pop ? ["stash", "pop"] : ["stash", "push", "--quiet"];
  }
  if (op === "stashes") {
    return ["stash", "list"];
  }
  if (op === "tags") {
    return ["tag", "--list"];
  }
  // a light tag on the current commit; git push does not send tags
  if (op === "tag") {
    const name = toText(notNull(await evaluate(command.value, state), "The tag name is null. Give it a value", command.value));
    if (!isSafeBranchName(name)) {
      throw new ScriptError("Not a safe tag name: " + describe(name) + ". Use letters, digits, -, _, / and .", command.value);
    }
    step.tag = name;
    return ["tag", name];
  }
  // blame: read only, with the checks of a read; .env files hold secrets
  if (op === "blame") {
    const file = await evaluate(command.value, state);
    if (!(file instanceof FileRef)) {
      throw new ScriptError("git blame needs a file, found " + describe(file), command.value);
    }
    const { relative } = await realTarget(file, state, command.value);
    if (isSecretFile(file.path) || isSecretFile(relative)) {
      throw new ScriptError("A script cannot read .env files, because they hold secrets: " + file.path, command.value);
    }
    if ((await realPath(file, state, command.value)) === null) {
      throw new ScriptError("File not found: " + file.path, command.value);
    }
    step.file = file.path;
    return ["blame", "--no-textconv", "--", file.path];
  }
  // restore: put files back as they are in the last commit, with the checks of a write; undo can take it back
  if (op === "restore") {
    const value = flatFiles(await evaluate(command.value, state));
    const files = Array.isArray(value) ? value : [value];
    if (files.length === 0) {
      throw new ScriptError("git restore found no files to restore", command.value);
    }
    for (const file of files) {
      await checkWritable(file, state, command.value);
      const stats = await fs.stat(file.absolute).catch(() => null);
      if (stats !== null && stats.isDirectory()) {
        throw new ScriptError("git restore needs files, not a folder: " + file.path, command.value);
      }
    }
    step.files = files.map((file) => file.path);
    step.refs = files;
    return ["restore", "--worktree", "--", ...step.files];
  }
  // pull: the current branch from origin, fast-forward only, with the hardening of a push
  if (op === "pull") {
    return ["pull", "--ff-only", "--no-rebase", "--no-recurse-submodules", "origin"];
  }
  throw new ScriptError("Unknown git operation: " + op, command);
}

// start a program with no shell, and wait for it; used by run and git
// gives { code, output }: the exit code, and stdout and stderr together, in the order they came
function spawnProgram(program, args, cwd, env, limit, state, node) {
  const signal = state.execution.signal;
  return new Promise((resolve, reject) => {
    let output = "";
    let bytes = 0;
    let timedOut = false;
    let tooMuch = false;
    let timer = null;

    // its own process group (not on Windows), so a stop also stops the programs it started
    const child = spawn(program, args, { cwd, env, shell: false, detached: process.platform !== "win32" });
    const stop = () => killGroup(child);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) {
      stop();
    }

    if (limit !== null) {
      timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, limit);
    }

    // at most RUN_OUTPUT_BYTES, so a program cannot fill the server's memory
    const collect = (chunk) => {
      if (tooMuch) {
        return;
      }
      bytes += chunk.length;
      if (bytes > RUN_OUTPUT_BYTES) {
        tooMuch = true;
        stop();
        return;
      }
      output += chunk;
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    child.on("error", (err) => {
      clearTimeout(timer);
      if (signal.aborted) {
        reject(new Cancelled("Cancelled", node));
      } else if (err.code === "ENOENT") {
        reject(new ScriptError("Cannot run '" + program + "': program not found", node));
      } else {
        reject(new ScriptError("Cannot run '" + program + "': " + err.message, node));
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      if (signal.aborted) {
        reject(new Cancelled("Cancelled", node));
      } else if (timedOut) {
        reject(new ScriptError("'" + program + "' did not finish within " + limit + "ms", node));
      } else if (tooMuch) {
        reject(new ScriptError("'" + program + "' gave more than " + RUN_OUTPUT_BYTES / (1024 * 1024) + " MB of output, so it was stopped. Make it print less, for example with a quieter reporter", node));
      } else {
        resolve({ code: code === null ? -1 : code, output });
      }
    });
  });
}

// the most output that run and git can give, stdout and stderr together
const RUN_OUTPUT_BYTES = 10 * 1024 * 1024;

// stop a program and the programs it started: its whole process group, where the OS has them
// a program that does not stop on SIGTERM gets SIGKILL 2 seconds later
function killGroup(child) {
  if (child.pid === undefined) {
    return;
  }
  const send = (name) => {
    try {
      if (process.platform === "win32") {
        child.kill(name);
      } else {
        process.kill(-child.pid, name);
      }
    } catch (err) {
      // the group is already gone
    }
  };
  send("SIGTERM");
  setTimeout(() => send("SIGKILL"), 2000).unref();
}

// ----- sandbox -----
// see src/md/features/sandbox-run.md and src/js/sandbox.js

// the self-test runs once for each server process, and its result stays
let sandboxTest = null;

// for the audit: "in a sandbox with network, " or ""
function sandboxText(sandbox) {
  if (sandbox === null) {
    return "no sandbox, ";
  }
  const options = [];
  if (sandbox.network) {
    options.push("network");
  }
  if (sandbox.localNetwork) {
    options.push("local network");
  }
  for (const path of sandbox.writes) {
    options.push("writes to " + path);
  }
  for (const path of sandbox.reads) {
    options.push("reads of " + path);
  }
  return "sandbox" + (options.length > 0 ? ", " + options.join(", ") : "") + ", ";
}

// "in a sandbox with ...": the values, or null for no sandbox; hooks see them as the step's sandbox
async function sandboxValues(command, state) {
  if (command.sandbox === null || command.sandbox === undefined) {
    return null;
  }
  const values = { network: command.sandbox.network, localNetwork: command.sandbox.localNetwork, reads: [], writes: [] };
  for (const path of command.sandbox.reads) {
    values.reads.push(grantPath(await evaluate(path, state), state));
  }
  for (const path of command.sandbox.writes) {
    values.writes.push(grantPath(await evaluate(path, state), state));
  }
  return values;
}

// a grant as a full path: a file value is its own path; @/x is from the root, ./x from the current folder
// ~ and ~/x stay as they are, for the sandbox to expand; never from the folder where the host started
function grantPath(value, state) {
  if (value instanceof FileRef) {
    return value.absolute;
  }
  const text = toText(value);
  if (text === "~" || text.startsWith("~/")) {
    return text;
  }
  if (text.startsWith("@/")) {
    return nodePath.resolve(state.root, text.slice(2));
  }
  return nodePath.resolve(state.cwd, text);
}

// the program and arguments with the OS sandbox around them, its env, and its temp folder
// fails closed: no sandbox, or a sandbox that does not hold, means the program does not run
async function sandboxCommand(program, args, sandbox, env, listen, state, node) {
  const support = await sandboxKind();
  if (support.kind === null) {
    throw new ScriptError("Cannot run in a sandbox: " + support.reason + ". Nothing ran", node);
  }
  // on Linux, the sandbox protects a hidden folder only if it exists when the program starts,
  // so .talk/ (the audit and the untrusted inputs) must exist first
  await fs.mkdir(nodePath.join(state.root, ".talk"), { recursive: true });
  if (support.kind === "linux" && listen && !sandbox.network) {
    throw new ScriptError("On Linux, a sandboxed start needs 'with network', or the host cannot reach the server. Nothing ran", node);
  }
  if (sandboxTest === null) {
    sandboxTest = await selfTest(support.kind);
  }
  if (!sandboxTest.ok) {
    throw new ScriptError("The sandbox does not hold on this machine: " + sandboxTest.problems.join(", ") + ". Nothing runs in a sandbox", node);
  }
  const tmp = await fs.mkdtemp(nodePath.join(os.tmpdir(), "clank-sandbox-"));
  const plan = await sandboxPlan({
    root: state.root,
    tmp,
    programDirs: await installDirs(program, env.PATH || ""),
    reads: sandbox.reads,
    writes: sandbox.writes,
    allowedChanges: state.allowedChanges,
    network: sandbox.network,
    localNetwork: sandbox.localNetwork,
    listen,
  });
  const wrapped = await wrapCommand(support.kind, plan, program, args, state.cwd);
  const home = await makeHome(plan);
  // CLANK_TALK_SANDBOXED: a ClankTalk inside the sandbox knows it cannot start another sandbox
  return { program: wrapped.program, args: wrapped.args, env: { ...env, TMPDIR: plan.tmp, HOME: home, CLANK_TALK_SANDBOXED: "1" }, tmp };
}

// ----- wait -----

const WAIT_UNTIL_LIMIT = 30_000;
// wait until with no "every": the first check after 200 ms, then twice as long each time, up to 5 seconds,
// so a fast local check is fast, and a long wait on a web page does not send a request every 200 ms
const WAIT_UNTIL_EVERY = 200;
const WAIT_UNTIL_SLOWEST = 5_000;

// wait for a time; cancel ends the wait at once
const MAX_TIMER = 2 ** 31 - 1;

function sleep(ms, state, node) {
  const signal = state.execution.signal;
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Cancelled("Cancelled", node));
      return;
    }
    // a timer can wait at most about 24.8 days, so a longer wait is a chain of timers; a negative wait is no wait
    const end = Date.now() + Math.max(0, ms);
    let timer;
    const next = () => {
      const left = end - Date.now();
      if (left <= 0) {
        signal.removeEventListener("abort", onAbort);
        resolve();
        return;
      }
      timer = setTimeout(next, Math.min(left, MAX_TIMER));
    };
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Cancelled("Cancelled", node));
    };
    next();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// wait until <condition> [within <duration>]: check every 200 ms
// an error in the condition counts as false, so a server that is not up yet is fine
// each check is one step
async function waitUntil(command, state) {
  let limit = WAIT_UNTIL_LIMIT;
  if (command.within !== null) {
    limit = await durationMs(command.within, state);
  }
  limit = shorter(state.timeLimit, limit);
  const started = Date.now();
  let lastError = null;
  const every = command.every ? await durationMs(command.every, state) : null;
  let pause = every === null ? WAIT_UNTIL_EVERY : every;
  while (true) {
    takeStep(command, state);
    try {
      if (isTrue(await evaluate(command.condition, state))) {
        return;
      }
      lastError = null;
    } catch (err) {
      if (err instanceof Cancelled || err instanceof StepBudget || !(err instanceof ScriptError)) {
        throw err;
      }
      lastError = err.message;
    }
    if (Date.now() - started + pause > limit) {
      const last = lastError === null ? "" : ". The last error: " + lastError;
      throw new ScriptError("wait until did not come true within " + limit + "ms" + last, command);
    }
    await sleep(pause, state, command);
    if (every === null) {
      pause = Math.min(pause * 2, WAIT_UNTIL_SLOWEST);
    }
  }
}

// ----- background processes -----
// see src/md/features/background.md

const MAX_PROCESSES = 5;
const PROCESS_OUTPUT_BYTES = 64 * 1024;

// one item of "the processes", or the value of "process <name>": a snapshot, not the live process
class ProcessInfo {
  constructor(record, state) {
    this.name = record.name;
    this.status = record.status;
    this.code = record.code;
    // the output can hold a secret's value
    this.output = redact(record.output, state);
  }
}

function processLine(info) {
  if (info.status === "exited") {
    return info.name + ": exited (code " + info.code + ")";
  }
  return info.name + ": " + info.status;
}

// start <program> as <name>, only in a tool
async function startProcess(command, state) {
  const { program, args } = await programAndArgs(command, state);
  const name = await processName(command, state);

  const step = Object.create(null);
  step.program = program;
  step.args = args;
  step.name = name;
  const sandbox = await sandboxValues(command, state);
  step.sandbox = sandbox;
  step.secrets = [...command.secrets];
  checkDenied("start", state, command);
  checkSandboxRequired("start", sandbox, state, command);
  await runHooks("before", ["start"], step, state, command);
  if (sandbox === null || sandbox.network) {
    await askUntrusted(state, "network runs", "Start " + [program, ...args].join(" ") + (sandbox === null ? " with no sandbox" : " with network"), command);
  }

  let env = programEnv(command, state);
  let spawnProgramName = await resolveProgram(program, env, state, command);
  let spawnArgs = args;
  let tmp = null;
  if (sandbox !== null) {
    const wrapped = await sandboxCommand(spawnProgramName, args, sandbox, env, true, state, command);
    spawnProgramName = wrapped.program;
    spawnArgs = wrapped.args;
    env = wrapped.env;
    tmp = wrapped.tmp;
  }

  // its own process group (not on Windows), so stop can end its children too
  const child = spawn(spawnProgramName, spawnArgs, { cwd: state.cwd, env, shell: false, detached: process.platform !== "win32" });
  if (tmp !== null) {
    child.on("close", () => {
      fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    });
  }
  // a program that an untrusted tool starts: its output is untrusted, see processInfo
  const record = { name, child, status: "running", code: null, output: "", untrustedFrom: state.untrustedTool || null };
  const add = (chunk) => {
    record.output += chunk;
    if (record.output.length > PROCESS_OUTPUT_BYTES) {
      record.output = record.output.slice(record.output.length - PROCESS_OUTPUT_BYTES);
    }
  };
  child.stdout.on("data", add);
  child.stderr.on("data", add);
  child.on("error", (err) => {
    add("Cannot start '" + program + "': " + (err.code === "ENOENT" ? "program not found" : err.message) + "\n");
    record.status = "exited";
    record.code = -1;
  });
  child.on("close", (code) => {
    if (record.status === "running") {
      record.status = "exited";
      record.code = code === null ? -1 : code;
    }
  });

  // newest last, so the list can show newest first
  state.processes.delete(name);
  state.processes.set(name, record);
  auditStep(state, "start", name, sandboxText(sandbox) + [program, ...args].join(" ") + secretNote(command.secrets));
  return new ProcessInfo(record, state);
}

// stop process <name>: any script can stop a process that ClankTalk started
async function stopProcess(command, state) {
  const name = toText(await evaluate(command.name, state));
  const record = state.processes.get(name);
  if (record === undefined) {
    throw new ScriptError("No process named " + describe(name), command);
  }
  if (record.status === "running") {
    const step = Object.create(null);
    step.name = name;
    await runHooks("before", ["stop"], step, state, command);
    record.status = "stopped";
    await endProcess(record);
    auditStep(state, "stop", name, "");
  }
  return await processInfo(record, state);
}

// end the process group, and wait up to 2 seconds before a hard kill
async function endProcess(record) {
  if (record.abort) {
    record.abort.abort();
    return;
  }
  const closed = new Promise((resolve) => {
    if (record.child.exitCode !== null || record.child.signalCode !== null) {
      resolve();
    } else {
      record.child.once("close", resolve);
    }
  });
  signalProcess(record, "SIGTERM");
  let timer = null;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve("late"), 2000);
  });
  if ((await Promise.race([closed, late])) === "late") {
    signalProcess(record, "SIGKILL");
  }
  clearTimeout(timer);
}

// the name for a new background process: valid, not running yet, and under the limit
async function processName(command, state) {
  const name = toText(await evaluate(command.name, state));
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new ScriptError("A process name needs letters, digits, -, _ or ., found " + describe(name), command.name);
  }
  const existing = state.processes.get(name);
  if (existing !== undefined && existing.status === "running") {
    throw new ScriptError("Process '" + name + "' is already running. Stop it first", command);
  }
  let running = 0;
  for (const record of state.processes.values()) {
    if (record.status === "running") {
      running++;
    }
  }
  if (running >= MAX_PROCESSES) {
    throw new ScriptError("At most " + MAX_PROCESSES + " processes can run at a time. Stop one first", command);
  }
  return name;
}

// a background subagent stops when its signal aborts; a program gets SIGTERM, then SIGKILL
function signalProcess(record, signal) {
  if (record.abort) {
    record.abort.abort();
    return;
  }
  try {
    if (process.platform !== "win32" && record.child.pid !== undefined) {
      process.kill(-record.child.pid, signal);
    } else {
      record.child.kill(signal);
    }
  } catch (err) {
    // the process is already gone
  }
}

/**
 * Stop every running process, at once; a host calls this when its session ends.
 * @param {Map} processes  the same Map the host passes as options.processes
 */
export function stopAllProcesses(processes) {
  for (const record of processes.values()) {
    if (record.status === "running") {
      record.status = "stopped";
      signalProcess(record, "SIGTERM");
    }
  }
}

async function processList(state) {
  const list = [];
  for (const record of state.processes.values()) {
    list.unshift(await processInfo(record, state));
  }
  return list;
}

// a process value for the script; the agent sees a subagent's answer, so new output of it goes to the store
async function processInfo(record, state) {
  const info = new ProcessInfo(record, state);
  // a subagent's answer, or the output of a program that an untrusted tool started
  const source = record.subagent || (record.untrustedFrom ? "process " + record.name + " (from tool " + record.untrustedFrom + ")" : null);
  if (source !== null && info.output.length > (record.storedLength || 0)) {
    await noteUntrusted(state, source, info.output);
    record.storedLength = info.output.length;
  }
  return info;
}

// ----- fetch -----

const FETCH_TIME_LIMIT = 30_000;
const FETCH_MAX_BYTES = 5 * 1024 * 1024;
const FETCH_MAX_REDIRECTS = 5;

// fetch <url> [as json | response | text] [with method, headers, body] [within <duration>]
// see src/md/features/fetch.md
async function runFetch(command, state) {
  checkDenied("fetch", state, command);
  const urlValue = await evaluate(command.url, state);
  // URLs go into the audit, hooks and errors, so a secret cannot go there
  if (urlValue instanceof Secret) {
    throw new ScriptError(secretUseMessage(urlValue, "the fetch URL", state), command.url);
  }
  const url = parseUrl(toText(urlValue), command.url);

  let method = "GET";
  let headers = {};
  let body;
  // the names of the secrets in the headers and the body
  const secrets = [];
  for (const arg of command.named) {
    const value = await evaluate(arg.value, state);
    if (arg.name === "method") {
      method = toText(value).toUpperCase();
    } else if (arg.name === "headers") {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new ScriptError("headers must be an object, such as { 'Accept': 'text/plain' }", arg.value);
      }
      for (const name of Object.keys(value)) {
        if (value[name] === null || value[name] === undefined) {
          throw new ScriptError("The header " + describe(name) + " is null. Give it a value, or leave it out", arg.value);
        }
        // the characters that HTTP allows in a header name; a line break could start a new header
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
          throw new ScriptError("Not a valid header name: " + describe(name) + ". Use letters, digits and '-'", arg.value);
        }
        headers[name] = toText(revealSecrets(value[name], secrets));
        if (/[\r\n\0]/.test(headers[name])) {
          throw new ScriptError("The header " + describe(name) + " has a line break or a NUL character. Remove it", arg.value);
        }
      }
    } else if (arg.name === "body") {
      // an object or a list goes as JSON
      if (value instanceof FileRef) {
        throw new ScriptError("A fetch body cannot be a file. To send its text, write: body: ./" + value.path + "'s text", arg.value);
      }
      if (value instanceof Secret) {
        body = revealSecrets(value, secrets);
      } else if (value instanceof Line) {
        body = value.text;
      } else if (value !== null && typeof value === "object") {
        body = JSON.stringify(revealSecrets(value, secrets));
        if (!Object.keys(headers).some((name) => name.toLowerCase() === "content-type")) {
          headers["Content-Type"] = "application/json";
        }
      } else {
        body = toText(value);
      }
    } else {
      throw new ScriptError("fetch takes method, headers and body, not '" + arg.name + "'", arg.value);
    }
  }

  checkSecretHosts(secrets, url, state, command);

  const step = Object.create(null);
  step.url = url.href;
  step.method = method;
  step.secrets = secrets;
  await runHooks("before", ["fetch"], step, state, command);
  // in an untrusted session, a fetch with a secret asks the human
  if (secrets.length > 0) {
    await askUntrusted(state, "secrets", "Send secret " + secrets.join(", ") + " to " + url.host, command);
  }

  let limit = shorter(state.timeLimit, FETCH_TIME_LIMIT);
  if (command.within !== null) {
    limit = shorter(limit, await durationMs(command.within, state));
  }
  const signal = AbortSignal.any([state.execution.signal, AbortSignal.timeout(limit)]);

  // follow redirects by hand, so each new host is checked too
  let current = url;
  let response = null;
  // the secrets stay with the request until a redirect to another origin drops the headers
  let carriesSecrets = secrets.length > 0;
  // after the first redirect, the server chose the URL, so an error can hold its text: that error goes to the store
  let redirected = false;
  try {
  for (let hops = 0; ; hops++) {
    await checkFetchHost(current, state, command);
    // a redirect on the same origin keeps the headers, so a URL pattern for a secret is checked again
    if (hops > 0 && carriesSecrets) {
      checkSecretHosts(secrets, current, state, command);
    }
    try {
      response = await fetch(current, { method, headers, body, redirect: "manual", signal });
    } catch (err) {
      if (state.execution.signal.aborted) {
        throw new Cancelled("Cancelled", command);
      }
      if (signal.aborted) {
        throw new ScriptError("fetch did not finish within " + limit + "ms: " + current.href, command);
      }
      throw new ScriptError("fetch failed: " + current.href + ": " + (err.cause ? err.cause.message : err.message), command);
    }
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || location === null) {
      break;
    }
    if (hops >= FETCH_MAX_REDIRECTS) {
      throw new ScriptError("fetch stopped after " + FETCH_MAX_REDIRECTS + " redirects: " + url.href, command);
    }
    const previous = current;
    redirected = true;
    let next;
    try {
      next = new URL(location, current).href;
    } catch (err) {
      throw new ScriptError("fetch got a redirect that is not a valid URL: " + describe(location), command);
    }
    current = parseUrl(next, command);
    // a redirect can send the request on to another place, so the audit records each one
    auditStep(state, "redirect", previous.href, response.status + " to " + current.href);
    // on a redirect to another origin (scheme, host or port), the script's headers stay behind,
    // because they often hold a key for the first host; a body is not sent on, it is an error
    // a 303, or a 301 or 302 after a POST, goes on as a GET with no body, as browsers do
    const becomesGet = response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST");
    if (current.origin !== previous.origin) {
      headers = {};
      carriesSecrets = false;
      // any other redirect keeps the body, for example a 307, or a 301 after a PUT
      if (body !== undefined && !becomesGet) {
        throw new ScriptError("fetch will not send the body on to another host: " + previous.origin + " redirects to " + current.origin, command);
      }
    }
    if (becomesGet) {
      method = "GET";
      body = undefined;
    }
  }
  } catch (err) {
    if (redirected && err instanceof ScriptError && !(err instanceof Cancelled)) {
      await noteUntrusted(state, url.href + " (an error after a redirect)", err.message, command);
    }
    throw err;
  }

  // a server can send a secret's value back, so the response text shows <secret NAME>
  const text = redact(await readLimited(response, current, command), state);
  step.status = response.status;
  // text from the web is untrusted: it must not drive an action without a question,
  // unless AGENTS.talk trusts the URL that the text came from, after all redirects
  const currentHost = current.hostname.toLowerCase().replace(/\.+$/, "");
  if (state.trustedFetch.some((rule) => fetchRuleAllows(rule, current, currentHost))) {
    auditStep(state, "trusted", current.href, "trust fetch from");
  } else {
    await noteUntrusted(state, current.href, text);
  }

  let result;
  if (command.as === "response") {
    const responseHeaders = Object.create(null);
    for (const [name, value] of response.headers) {
      responseHeaders[name] = redact(value, state);
    }
    result = { status: response.status, headers: responseHeaders, text };
  } else {
    if (response.status >= 400) {
      throw new ScriptError("fetch got status " + response.status + " from " + current.href + ": " + describe(text), command);
    }
    if (command.as === "json") {
      try {
        result = JSON.parse(text);
      } catch (err) {
        throw new ScriptError("fetch did not get valid JSON from " + current.href + ": " + describe(text), command);
      }
    } else {
      result = text;
    }
  }
  auditStep(state, "fetch", method + " " + current.href, response.status + ", " + Buffer.byteLength(text) + " bytes" + secretNote(secrets));
  state.result = result;
  await runHooks("after", ["fetch"], step, state, command);
  return result;
}

function parseUrl(text, node) {
  let url;
  try {
    url = new URL(text);
  } catch (err) {
    throw new ScriptError("Not a valid URL: " + describe(text), node);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ScriptError("fetch only takes http and https URLs, found " + describe(text), node);
  }
  // fetch refuses a URL with a user name or password, and its error shows the password
  if (url.username !== "" || url.password !== "") {
    throw new ScriptError("A fetch URL cannot hold a user name or password. Send them in a header, such as Authorization", node);
  }
  return url;
}

// read the body as text, and stop at the size limit
async function readLimited(response, url, node) {
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.length;
    if (size > FETCH_MAX_BYTES) {
      await reader.cancel();
      throw new ScriptError("fetch got more than " + FETCH_MAX_BYTES + " bytes from " + url.href, node);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// each secret can go only to the hosts in its "allow secret" line
function checkSecretHosts(secrets, url, state, node) {
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  for (const name of secrets) {
    const entry = state.secrets.get(name);
    if (!entry.hosts.some((rule) => fetchRuleAllows(rule, url, host))) {
      const allowed = entry.hosts.length === 0 ? "a run or start in a tool that is provided it" : entry.hosts.join(", ");
      const target = entry.hosts.some(isUrlRule) ? url.origin + url.pathname : host;
      throw new ScriptError("A secret cannot go to " + target + ": " + name + ". It can go only to " + allowed + ".", node);
    }
  }
}

// a host is allowed if AGENTS.talk names it, or the human said yes in this session
// a local or private address must be named in AGENTS.talk
async function checkFetchHost(url, state, node) {
  // localhost. and localhost are the same host
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  const limit = state.policy === null ? undefined : state.policy.rules.find((rule) => rule.type === "limit" && rule.what === "fetch");
  if (limit !== undefined && !isAllowedFetchHost(host, limit.values)) {
    throw new ScriptError("fetch refused: " + host + " is outside the policy '" + state.policy.name + "' (" + ruleAt(limit) + ")", node);
  }
  const allowLine = "To allow it, a human can add this line to AGENTS.talk:\n  allow fetch from '" + host + "'";
  // a trusted URL is allowed too: a source that the human trusts must not ask; see src/md/features/taint.md
  const rules = state.allowedFetch.concat(state.trustedFetch);
  // a private host needs its own line in AGENTS.talk; a *. pattern is not enough
  if (isPrivateHost(host)) {
    if (rules.some((rule) => ruleHost(rule) === host && fetchRuleAllows(rule, url, host))) {
      return;
    }
    throw new ScriptError("fetch refused: " + host + " is a local or private address.\n" + allowLine, node);
  }
  // a public name can point to a private address, so look at the addresses too
  // limit: the connection does its own lookup, so a name that changes its answer in between is not caught
  if (!rules.some((rule) => ruleHost(rule) === host)) {
    for (const address of await state.lookup(host)) {
      if (isPrivateHost(address)) {
        throw new ScriptError("fetch refused: " + host + " points to a local or private address (" + address + ").\n" + allowLine, node);
      }
    }
  }
  if (rules.some((rule) => fetchRuleAllows(rule, url, host)) || state.fetchHosts.has(host)) {
    return;
  }
  // in an untrusted session, one question covers the session and the new host; a yes allows the host for the session
  // otherwise: yes once, yes for the session, or no
  if (!(await askUntrusted(state, "new hosts", "Fetch from " + host, node))) {
    const answer = await askState(state, "Fetch from " + host + "?", ["yes, once", "yes, for this session", "no"], null);
    if (answer === "yes, once") {
      return;
    }
    if (answer !== "yes, for this session") {
      throw new ScriptError("The human did not approve a fetch from " + host + askReason(state) + ".\n" + allowLine, node);
    }
  }
  state.fetchHosts.add(host);
}

// the warnings for '*' in "allow fetch from" and "trust fetch from"; the taint command shows them too
export function wideFetchWarnings(agents) {
  const warnings = [];
  if (agents.trustedFetch.includes("*")) {
    warnings.push("AGENTS.talk trusts text from all public hosts (trust fetch from '*'): fetched text does not taint the session.");
  }
  if (agents.allowedFetch.includes("*")) {
    warnings.push("AGENTS.talk allows fetch from all public hosts (allow fetch from '*').");
  }
  return warnings;
}

// the addresses of a name, in the URL parser's form, so isPrivateHost can read them
// a name that does not resolve gives no addresses; the fetch then fails on its own
async function lookupHost(host) {
  if (host.startsWith("[") || /^[\d.]+$/.test(host)) {
    return [];
  }
  try {
    const answers = await dns.lookup(host, { all: true });
    return answers.map((answer) => new URL("http://" + (answer.family === 6 ? "[" + answer.address + "]" : answer.address)).hostname);
  } catch (err) {
    return [];
  }
}

// 'api.github.com' allows that host; '*.github.com' allows hosts under github.com
function isAllowedFetchHost(host, allowed) {
  for (const pattern of allowed) {
    if (pattern === host) {
      return true;
    }
    if (pattern.startsWith("*.") && host.endsWith(pattern.slice(1))) {
      return true;
    }
  }
  return false;
}

// a fetch rule from AGENTS.talk is a host ('api.github.com', '*.github.com')
// or a URL pattern (http://localhost:5173/, https://*.github.com/repos/**); see src/md/features/fetch.md
function isUrlRule(rule) {
  return rule.includes("://");
}

// the host of a rule: https://*.github.com/x gives *.github.com
function ruleHost(rule) {
  return isUrlRule(rule) ? new URL(rule).hostname : rule;
}

// a rule as AGENTS.talk writes it: a host in quotes, a URL with none
function shownRule(rule) {
  return isUrlRule(rule) ? rule : "'" + rule + "'";
}

// the rule allows the URL; host is the URL's host in lower case, with no dot at the end
// a URL pattern must have the same scheme and port; in its host, *. is one more part
function fetchRuleAllows(rule, url, host) {
  // '*' is every public host; a private host needs its own line, so a trusted page cannot reach it
  if (rule === "*") {
    return !isPrivateHost(host);
  }
  if (!isUrlRule(rule)) {
    return isAllowedFetchHost(host, [rule]);
  }
  const pattern = new URL(rule);
  if (pattern.protocol !== url.protocol || pattern.port !== url.port) {
    return false;
  }
  const patternHost = pattern.hostname;
  if (patternHost.startsWith("*.")) {
    const rest = patternHost.slice(1);
    const first = host.slice(0, host.length - rest.length);
    if (!host.endsWith(rest) || first === "" || first.includes(".")) {
      return false;
    }
  } else if (patternHost !== host) {
    return false;
  }
  return urlPathMatches(pattern.pathname, url.pathname);
}

// a path that ends in / allows all paths below it; * is any text in one part, ** is any number of parts
// the URL parser already removed . and .. parts from both paths
function urlPathMatches(pattern, path) {
  const wanted = pattern.split("/").slice(1);
  if (pattern.endsWith("/")) {
    wanted[wanted.length - 1] = "**";
  }
  return pathPartsMatch(wanted, path.split("/").slice(1));
}

function pathPartsMatch(wanted, given) {
  if (wanted.length === 0) {
    return given.length === 0;
  }
  if (wanted[0] === "**") {
    for (let skip = 0; skip <= given.length; skip++) {
      if (pathPartsMatch(wanted.slice(1), given.slice(skip))) {
        return true;
      }
    }
    return false;
  }
  if (given.length === 0 || !wildcardMatch(wanted[0], given[0])) {
    return false;
  }
  return pathPartsMatch(wanted.slice(1), given.slice(1));
}

// text matches a pattern where * is any text and each other character is itself
// fetch URL paths and "allow harness tools" names use it
export function wildcardMatch(pattern, text) {
  if (!pattern.includes("*")) {
    return pattern === text;
  }
  const source = pattern.split("*").map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp("^" + source + "$", "u").test(text);
}

// localhost, and IP addresses that are not plain public ones: loopback, private, link-local,
// shared, benchmark, multicast and reserved; for IPv6 also the forms that hold an IPv4 address
// the URL parser already gives a normal form: 127.1 and 0x7f.1 are 127.0.0.1, IPv6 is lower case hex
function isPrivateHost(host) {
  if (host === "localhost" || host.endsWith(".localhost")) {
    return true;
  }
  // IPv6 hosts come in brackets
  if (host.startsWith("[")) {
    const groups = ipv6Groups(host.slice(1, -1));
    const [g0, g1] = groups;
    // ::/96 (::, ::1, ::127.0.0.1) and ::ffff:0:0/96 (mapped IPv4)
    if (groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0 || groups[5] === 0xffff)) {
      return true;
    }
    // ::ffff:0:0:0/96 (IPv4-translated) holds an IPv4 address too
    if (groups.slice(0, 4).every((g) => g === 0) && groups[4] === 0xffff && groups[5] === 0) {
      return true;
    }
    // NAT64 64:ff9b::/96 and 6to4 2002::/16 hold an IPv4 address
    if ((g0 === 0x64 && g1 === 0xff9b) || g0 === 0x2002) {
      return true;
    }
    // 100::/64 discards packets, and 2001:db8::/32 is for documentation: no public service is there
    if ((g0 === 0x100 && groups.slice(1, 4).every((g) => g === 0)) || (g0 === 0x2001 && g1 === 0xdb8)) {
      return true;
    }
    // fc00::/7 unique local; fe80::/10 link-local and fec0::/10 site-local; ff00::/8 multicast
    return (g0 & 0xfe00) === 0xfc00 || g0 >= 0xfe80;
  }
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d+$/.test(part))) {
    return false;
  }
  const [a, b, c] = parts.map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19));
}

// the 8 numbers of an IPv6 address in the URL parser's form, such as ::ffff:7f00:1
function ipv6Groups(ip) {
  const [head, tail] = ip.includes("::") ? ip.split("::") : [ip, null];
  const left = head === "" ? [] : head.split(":");
  const right = tail === null || tail === "" ? [] : tail.split(":");
  const middle = tail === null ? [] : new Array(8 - left.length - right.length).fill("0");
  return [...left, ...middle, ...right].map((group) => parseInt(group, 16));
}

// ----- ask -----

// ask the human; only the host can reach them, through options.ask
// with no host, no answer in time, or an answer that is not a choice, the result is null
async function askHuman(command, state) {
  // a file is its path, as in + and ${}; write file's text to ask about its text
  const question = toText(joinPart(notNull(await evaluate(command.question, state), "The question is null. Give it a value", command.question)));
  const choices = [];
  for (const choice of command.choices) {
    const text = toText(joinPart(notNull(await evaluate(choice, state), "A choice is null. Give it a value", choice)));
    // the same choice twice is shown once
    if (!choices.includes(text)) {
      choices.push(text);
    }
  }
  let limit = state.timeLimit;
  if (command.within !== null) {
    limit = shorter(limit, await durationMs(command.within, state));
  }
  const answer = await askState(state, question, choices, limit, null, command.many);
  if (answer === null) {
    return null;
  }
  return command.many ? answer.map(choiceValue) : choiceValue(answer);
}

// a choice 'staging: the test site' gives 'staging'; the human sees all of it
// only ': ' splits, so 'http://x' stays whole; see src/md/features/ask.md
function choiceValue(text) {
  const at = text.indexOf(": ");
  return at > 0 ? text.slice(0, at) : text;
}

// a question to the human waits at most this long, unless "within" says otherwise;
// a client that cannot show the dialog (for example on a phone) must not hang the script
const ASK_TIME_LIMIT = 2 * 60 * 1000;

// ----- session taint; see src/md/features/taint.md and src/js/untrusted.js -----

// what asks by default: the actions that do harm outside the machine; more questions make people say yes without reading
const DEFAULT_TAINT_ASKS = ["push", "secrets"];

// the agent saw untrusted text: save it in the store, so the session is untrusted until the human approves it
// node is the command, for an error; a process read has none
async function noteUntrusted(state, source, text, node = { line: 1, column: 1 }) {
  if (state.taintMode === "off") {
    return;
  }
  const where = untrusted.storePath(state.session);
  let entry;
  try {
    entry = await untrusted.record(state.root, state.session, { source: redact(source, state), text: redact(text, state), time: untrusted.localTime(), keepBytes: state.keepUntrustedBytes });
  } catch (err) {
    throw new ScriptError("Could not save untrusted input in " + where + ": " + err.message, node);
  }
  // the same source and text as an input that is there: no new copy; an approved one does not taint again
  if (entry.same !== undefined) {
    auditStep(state, "untrusted", source, "the same as " + entry.session + "/" + entry.entry.n + ", " + entry.same);
    return;
  }
  auditStep(state, "untrusted", source, "saved as " + where + entry.file);
  if (entry.cut) {
    state.execution.warnings.push({ message: "warning: untrusted input " + entry.n + " is " + sizeText(entry.size) + "; the store kept the first " + sizeText(state.keepUntrustedBytes), line: 1, column: 1 });
  }
  if (state.judge.automatically) {
    await judgeNow(state, entry, redact(text, state));
  }
}

// "judge untrusted inputs automatically": the judge reads the new input; a failure is a warning, and the input stays
async function judgeNow(state, entry, text) {
  let verdict;
  try {
    const ask = judgeModel(state.judge.model || state.useModel, state.lendModel, state.secrets, state.subagentUrl);
    verdict = await judgeText({ ask, prompt: state.judge.prompt, source: entry.source, text, signal: state.execution.signal });
  } catch (err) {
    state.execution.warnings.push({ message: "warning: the judge could not read untrusted input " + entry.n + ": " + redact(err.message, state), line: 1, column: 1 });
    return;
  }
  const approved = await untrusted.setVerdict(state.root, state.session, entry.n, verdict, state.judge.approves);
  auditStep(state, "judge", entry.source, verdict.result + (verdict.reason ? ": " + verdict.reason : "") + (approved ? ", approved" : ""));
}

// the model of the judge: lent by the harness, or from "use model" with a key; throws a plain Error
function judgeModel(use, lendModel, secrets, url) {
  if (lendModel) {
    return lendModel(use === null ? null : use.model);
  }
  if (use === null || use.secret === null) {
    throw new Error("the judge needs a model and a key in AGENTS.talk: use model 'claude-haiku-5-5' for judging with secret ANTHROPIC_API_KEY");
  }
  const entry = secrets.get(use.secret);
  if (entry === undefined || entry.value === null) {
    throw new Error("no value for secret " + use.secret + ". Put it in the environment, in .env.local or in .env");
  }
  return anthropicModel({ url, key: entry.value, model: use.model });
}

// for the harness: is there an AGENTS.talk, does it require ClankTalk, and which other tools does it allow
// see src/md/features/harness-tools.md; errors are AGENTS.talk's own, so a harness can fail closed
export async function projectHarness(root) {
  const resolved = nodePath.resolve(root);
  const exists = fsSync.existsSync(nodePath.join(resolved, AGENTS_TALK));
  const agents = await loadAgentsTalk(resolved, {});
  return { agentsTalk: exists, required: agents.requireClankTalk, allowed: agents.harnessTools, untrusted: agents.untrustedHarnessTools, errors: agents.errors.map((error) => error.message) };
}

// an allowed harness tool ran while ClankTalk was on: an audit record, and for an untrusted tool, an untrusted input
// the harness decides "untrusted" from projectHarness's list; see src/md/features/harness-tools.md
// gives the ref of the stored input, such as claude-code-4f2a/3, or null
export async function recordHarnessTool(root, { session, tool, input, output, untrusted: isUntrusted }) {
  const resolved = nodePath.resolve(root);
  const agents = await loadAgentsTalk(resolved, {});
  const text = typeof output === "string" ? output : JSON.stringify(output) ?? "";
  const shownInput = oneLine(JSON.stringify(input) ?? "").slice(0, 300);
  let ref = null;
  const mode = untrusted.taintMode(agents.taint, false, await untrusted.commandLineMode(resolved));
  if (isUntrusted && mode !== "off") {
    const found = await untrusted.record(resolved, session, { source: tool + " " + shownInput, text, time: untrusted.localTime(), keepBytes: agents.keepUntrustedBytes || untrusted.DEFAULT_KEEP_BYTES });
    ref = found.same ? found.session + "/" + found.entry.n : session + "/" + found.n;
  }
  const now = new Date();
  const folder = nodePath.join(resolved, ".talk", "audit");
  await fs.mkdir(folder, { recursive: true });
  let name = localDate(now) + ".log";
  let block;
  if (agents.auditFormat === "json") {
    name = localDate(now) + ".jsonl";
    block = JSON.stringify({ type: "harnessTool", time: now.toISOString(), session, tool, input, size: text.length, untrusted: ref }) + "\n";
  } else {
    block = "== " + clock(now) + "  harness tool " + oneLine(tool) + "  (session " + oneLine(session) + ") ==\n  " + shownInput + "\n--\n  result: " + text.length + " characters" + (ref === null ? "" : "; untrusted input " + ref) + "\n\n";
  }
  await fs.appendFile(nodePath.join(folder, name), block);
  await untrusted.wroteOwn(nodePath.join(folder, name));
  return ref;
}

// the '*' warnings for the taint command, which reads AGENTS.talk on its own
export async function projectFetchWarnings(root) {
  return wideFetchWarnings(await loadAgentsTalk(nodePath.resolve(root), {}));
}

// for "npx clank-talk taint judge": the judge of the project, from AGENTS.talk and the secrets
// gives { judge(source, text), approves } or { error }
export async function projectJudge(root, options = {}) {
  const agents = await loadAgentsTalk(nodePath.resolve(root), {});
  if (agents.errors.length > 0) {
    return { error: "AGENTS.talk has errors: " + agents.errors.map((error) => error.message).join("; ") };
  }
  const secrets = await loadSecrets(nodePath.resolve(root), agents.allowedSecrets);
  let ask;
  try {
    ask = judgeModel(agents.judge.model || agents.useModel, options.lendModel || null, secrets.secrets, options.url || API_URL);
  } catch (err) {
    return { error: "The judge cannot run: " + err.message };
  }
  return { approves: agents.judge.approves, judge: (source, text) => judgeText({ ask, prompt: agents.judge.prompt, source, text }), lines: (source, text) => judgeLines({ ask, source, text }) };
}

// at most this many characters, with "..." at the end of a longer text
function cutText(text, most) {
  return text.length > most ? text.slice(0, most - 3) + "..." : text;
}

// after a run with no sandbox: if it changed the taint files, put them back, audit it, make the session untrusted, and fail
async function checkTalkFolder(state, before, program, node) {
  const { changed, restored } = await untrusted.check(state.root, before);
  if (changed.length === 0) {
    return;
  }
  const back = restored.length === 0 ? "" : "; put back " + restored.join(", ");
  auditStep(state, "restore", ".talk/", program + " changed " + changed.join(", ") + back);
  // the audit as it was before the run, so the human can compare it with the file now
  if (before.audit !== null) {
    state.execution.output.push(redact("--- the last " + before.audit.lines.length + " lines of " + before.audit.file + " before the run ---\n" + before.audit.lines.join("\n"), state));
  }
  if (state.taintMode !== "off") {
    await noteUntrusted(state, "run " + program + " changed .talk/", "The program changed these files, and ClankTalk put them back:\n" + changed.join("\n"), node);
  }
  throw new ScriptError("The program " + program + " changed files in .talk/, which scripts and programs must not change: " + changed.join(", ") + "." + (restored.length === 0 ? "" : " ClankTalk put back " + restored.join(", ") + ".") + (before.audit === null ? "" : " The output shows the audit from before the run.") + " Run the program in a sandbox", node);
}

// a hint for the common causes of a pattern that is not valid; see src/md/features/language.md
function patternHint(message) {
  if (/\(\?[imsx-]+[):]/.test(message)) {
    return ".\nJavaScript has no (?i) or other inline flags. For a match with no case, use a character class such as [Tt]aint.";
  }
  if (message.endsWith("Invalid escape")) {
    return ".\nWith the u flag, an escape that is not needed is an error, such as \\- outside [...]: write - alone.";
  }
  if (/Unterminated group|Nothing to repeat|Incomplete quantifier|Lone quantifier/.test(message)) {
    return ".\nIn a quoted string, a backslash is an escape of the string, so \\( reaches the pattern as (. For a pattern with backslashes, write it raw: pattern /test\\(/.";
  }
  return "";
}

// "found null" in an error: say what null means here
function nullHint(message) {
  if (!/found null$/.test(message)) {
    return message;
  }
  return message + ": the value has nothing in it.\nIf it came from an earlier find or fetch, that command found nothing.";
}

// 1536 bytes is "2 KB", 5242880 is "5 MB"
function sizeText(bytes) {
  return bytes >= 1024 * 1024 ? Math.ceil(bytes / (1024 * 1024)) + " MB" : Math.ceil(bytes / 1024) + " KB";
}

// in an untrusted session, a risky action asks the human; no answer, or no, is an error
// gives true if it asked and the human said yes, false if it did not ask
// kind is one of TAINT_ASKS; only the kinds in "taint asks before" (or the default) ask
async function askUntrusted(state, kind, action, node) {
  if (state.taintMode === "off" || !state.taintAsks.includes(kind)) {
    return false;
  }
  // taint is for the whole project: the inputs of all sessions that are not approved
  const entries = await untrusted.pendingAll(state.root);
  if (entries.length === 0) {
    return false;
  }
  const shown = action.length > 120 ? action.slice(0, 117) + "..." : action;
  // the question names at most 5 inputs, and "approve" approves only those; a source is cut, with no control characters
  const named = entries.slice(0, 5);
  const sources = named.map(({ entry }) => cutText(untrusted.printable(entry.source), 80)).join(", ") + (entries.length > 5 ? ", and " + (entries.length - 5) + " more" : "");
  const count = entries.length === 1 ? "1 untrusted input is" : entries.length + " untrusted inputs are";
  const question = redact(shown + "? " + count + " not approved: " + sources + ". Review them with: npx clank-talk taint", state);
  const answer = await askState(state, question, ["approve and untaint", "yes, this time only", "no"], null);
  if (answer === "approve and untaint") {
    const refs = [];
    for (const session of new Set(named.map((item) => item.session))) {
      const numbers = await untrusted.approve(state.root, session, named.filter((item) => item.session === session).map((item) => item.entry.n));
      refs.push(...numbers.map((n) => session + "/" + n));
    }
    auditStep(state, "approve", untrusted.STORE + "/", "untrusted inputs " + refs.join(", "));
    return true;
  }
  if (answer === "yes, this time only") {
    return true;
  }
  throw new ScriptError("The human did not approve this while untrusted inputs are not approved: " + shown + askReason(state) + ".", node);
}

// a form shows at most this many inputs; the human can run taint review again for the rest
const REVIEW_INPUTS = 20;

// taint review: a form with a table of the inputs that are not approved, and a box to approve each one
// only the human answers the form; gives the number of inputs approved; see src/md/features/taint.md
async function taintReview(command, state) {
  const entries = await untrusted.pendingAll(state.root);
  if (entries.length === 0) {
    return 0;
  }
  if (state.ask === null) {
    throw new ScriptError("taint review failed: there is no way to show a form to the human here. Ask them to run: npx clank-talk taint", command);
  }
  const shown = entries.slice(0, REVIEW_INPUTS);
  const refs = shown.map(({ session, entry }) => session + "/" + entry.n);
  const rows = [["ref", "time", "size", "judge", "source"]];
  shown.forEach(({ entry }, k) => {
    // the source can hold text that the agent chose, so it is in quotes: it cannot pass for a column or a row
    rows.push([refs[k], entry.time, sizeText(entry.size), entry.verdict ? entry.verdict.result : "-", '"' + cutText(untrusted.printable(entry.source), 80) + '"']);
  });
  // short lines: the client cuts a long line
  const more = entries.length > shown.length ? "\nAnd " + (entries.length - shown.length) + " more: run taint review again." : "";
  const question = redact("Approve the untrusted inputs that you trust.\n\n" + untrusted.table(rows).join("\n") + "\n\nRead one with: npx clank-talk taint show <ref>" + more, state);
  const fields = refs.map((ref, k) => ({ name: "input" + k, title: "approve " + ref }));
  const answer = await askState(state, question, [], null, fields);
  if (answer === null) {
    throw new ScriptError("taint review got no answer" + askReason(state) + ". Nothing was approved.", command);
  }
  const refsApproved = [];
  for (const session of new Set(shown.map((item) => item.session))) {
    const numbers = shown.filter((item, k) => item.session === session && answer["input" + k]).map((item) => item.entry.n);
    if (numbers.length > 0) {
      refsApproved.push(...(await untrusted.approve(state.root, session, numbers, "the review")).map((n) => session + "/" + n));
    }
  }
  if (refsApproved.length > 0) {
    auditStep(state, "approve", untrusted.STORE + "/", "untrusted inputs " + refsApproved.join(", "));
  }
  return refsApproved.length;
}

// why an approval did not come: no way to ask, or no answer in time; empty for a plain "no"
function askReason(state) {
  if (state.ask === null) {
    return ": there is no way to ask them here";
  }
  if (state.askTimedOut) {
    return ": nobody answered in time";
  }
  return "";
}

// ask through the host, with a time limit in ms (null: the default); used by ask, git push and fetch
// with fields ([{ name, title }]), the host shows a form of yes or no boxes and gives { name: true or false }
// state.askTimedOut tells the caller that nobody answered in time
// many: the human can pick several of the choices, and the answer is a list of them
async function askState(state, question, choices, limit, fields = null, many = false) {
  state.askTimedOut = false;
  if (state.ask === null) {
    return null;
  }
  if (limit === null) {
    limit = state.askTimeLimit;
  }
  let timer = null;
  let answer = null;
  // the end of the script or the time limit stops the question, so the host can close its dialog
  const stop = new AbortController();
  const stopAsk = () => stop.abort();
  state.execution.signal?.addEventListener("abort", stopAsk);
  try {
    const request = { question, choices, signal: stop.signal };
    if (fields !== null) {
      request.fields = fields;
    }
    if (many) {
      request.many = true;
    }
    const asking = state.ask(request);
    if (limit === null) {
      answer = await asking;
    } else {
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => {
          state.askTimedOut = true;
          stop.abort();
          resolve(null);
        }, limit);
      });
      answer = await Promise.race([asking, timeout]);
    }
  } catch (err) {
    // a host that fails to ask gives no answer
    answer = null;
  } finally {
    clearTimeout(timer);
    state.execution.signal?.removeEventListener("abort", stopAsk);
  }

  if (many) {
    // a list of the choices; none picked is an empty list, and anything else is no answer
    answer = Array.isArray(answer) && answer.every((item) => choices.includes(item)) ? choices.filter((choice) => answer.includes(choice)) : null;
  } else if (fields !== null) {
    // a form: only the true boxes count
    answer = answer !== null && typeof answer === "object" ? Object.fromEntries(fields.map((field) => [field.name, answer[field.name] === true])) : null;
  } else if (typeof answer !== "string" || (choices.length > 0 && !choices.includes(answer))) {
    answer = null;
  }
  let answerText = "answer: " + (fields !== null && answer !== null ? fields.filter((field) => answer[field.name]).map((field) => field.title).join(", ") || "none" : many && answer !== null ? answer.join(", ") || "none" : answer);
  if (answer === null) {
    answerText = state.askTimedOut ? "no answer within " + Math.round(limit / 1000) + " s" : "no answer";
  }
  auditStep(state, "ask", question, answerText);
  return answer;
}

// ----- audit -----
// see src/md/features/audit.md

// the session keeps at most this many records for "the audit"
const AUDIT_RECORDS = 5000;

function clock(date) {
  return date.toTimeString().slice(0, 8);
}

function localDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return date.getFullYear() + "-" + month + "-" + day;
}

// one step that touches the world: kind (read, write, run, ...), target (a path, a program, a url), details
// extra: more fields for the JSON audit only, such as the full git arguments
function auditStep(state, kind, target, details, extra = {}) {
  const record = { time: clock(new Date()), script: state.auditScript, agent: state.agent, kind, target: redact(String(target), state), details: redact(details || "", state), from: state.auditFrom };
  if (state.auditLine !== null && state.auditLine !== undefined) {
    record.line = state.auditLine;
  }
  if (state.auditBecause !== null && state.auditBecause !== undefined) {
    record.because = redact(state.auditBecause, state);
  }
  for (const name of Object.keys(extra)) {
    record[name] = redact(String(extra[name]), state);
  }
  state.auditSteps.push(record);
  state.audit.records.push(record);
  if (state.audit.records.length > AUDIT_RECORDS) {
    state.audit.records.shift();
  }
}

// a read is recorded once for each file in a script
function auditRead(state, path) {
  if (!state.auditReads.has(path)) {
    state.auditReads.add(path);
    auditStep(state, "read", path, "");
  }
}

// one line for the text audit: a line break, a tab or another control character shows as \n, \t, \u001b
// thus a script cannot fake a header or a step with a line break in a value
const ESCAPES = { "\n": "\\n", "\r": "\\r", "\t": "\\t" };
function oneLine(text) {
  return String(text).replace(/[\x00-\x1f\x7f\u2028\u2029]/g, (ch) => ESCAPES[ch] || "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
}

function cut(text, width) {
  return text.length > width ? text.slice(0, width - 3) + "..." : text;
}

// a step from inside a tool or a subagent is indented under it, so "from" is not needed
function auditLine(record) {
  const kind = record.from !== "script" ? "  " + record.kind.padEnd(6) : record.kind.padEnd(8);
  let text = (record.time + "  " + kind + " " + cut(oneLine(record.target), 40).padEnd(40) + "  " + oneLine(record.details)).trimEnd();
  if (record.because !== undefined) {
    text += "  because: " + cut(oneLine(record.because), 80);
  }
  if (record.line !== undefined) {
    text += "  (line " + record.line + ")";
  }
  return text;
}

// the audit keeps this many days by default; see src/md/features/audit.md
const AUDIT_KEEP_DAYS = 3;

function keepDays(agents, policy) {
  if (agents.keepAudit !== null) {
    return agents.keepAudit.days;
  }
  const keep = policy === null ? undefined : policy.rules.find((rule) => rule.type === "keepAudit");
  return Math.max(AUDIT_KEEP_DAYS, keep === undefined ? 0 : keep.days);
}

// once a day for each audit folder: delete the day files older than the kept days, and note it in the audit
// only names such as 2026-11-10.log and 2026-11-10.jsonl; the policy's "audit also to" copy is never rotated
const auditRotated = new Map();
async function rotateAudit(state, folder, now) {
  const today = localDate(now);
  if (auditRotated.get(folder) === today) {
    return;
  }
  auditRotated.set(folder, today);
  const oldest = localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (state.auditKeepDays - 1)));
  let names;
  try {
    names = await fs.readdir(folder);
  } catch (err) {
    return;
  }
  let deleted = 0;
  for (const name of names) {
    const match = /^(\d{4}-\d{2}-\d{2})\.(log|jsonl)$/.exec(name);
    if (match !== null && match[1] < oldest) {
      await fs.rm(nodePath.join(folder, name), { force: true });
      untrusted.deletedOwn(nodePath.join(folder, name));
      deleted++;
    }
  }
  if (deleted > 0) {
    auditStep(state, "audit", ".talk/audit/", "deleted " + deleted + (deleted === 1 ? " file" : " files") + " older than " + state.auditKeepDays + (state.auditKeepDays === 1 ? " day" : " days"));
  }
  // the untrusted inputs go with the audit; see src/md/features/taint.md
  const sessions = await untrusted.prune(state.root, oldest);
  if (sessions.length > 0) {
    auditStep(state, "audit", untrusted.STORE + "/", "deleted " + sessions.length + (sessions.length === 1 ? " session" : " sessions") + " older than " + state.auditKeepDays + (state.auditKeepDays === 1 ? " day" : " days") + ": " + sessions.join(", "));
  }
}

// the last session written to each audit file, for the session line
const auditSessions = new Map();

// append this script's block to the day's file in .talk/audit/; scripts cannot change @/.talk/
// a failure to write is a warning, so the audit never breaks a script
async function writeAudit(state, source, status, errors) {
  if (!state.auditToFile) {
    return;
  }
  try {
    const now = new Date();
    const folder = nodePath.join(state.root, ".talk", "audit");
    await fs.mkdir(folder, { recursive: true });
    await rotateAudit(state, folder, now);
    let text = "";
    let name = localDate(now) + ".log";
    if (state.auditFormat === "json") {
      name = localDate(now) + ".jsonl";
      const policyInfo = state.policy === null ? null : { name: state.policy.name, hash: state.policy.hash };
      text += JSON.stringify({ type: "script", time: now.toISOString(), session: state.session, script: state.auditScript, agent: state.agent, policy: policyInfo, status, steps: state.execution.steps, source, errors }) + "\n";
      for (const record of state.auditSteps) {
        text += JSON.stringify({ type: "step", ...record }) + "\n";
      }
    } else {
      // a session line when the session changes in this file; the header then has no session name
      const file = nodePath.join(folder, name);
      if (state.session !== null && auditSessions.get(file) !== state.session) {
        auditSessions.set(file, state.session);
        text += "-- session " + oneLine(state.session) + " --\n";
      }
      // an agent name only for an agent that passed one, such as a subagent; the main agent has none
      const who = state.agent === null ? "" : " (" + oneLine(state.agent) + ")";
      const under = state.policy === null ? "" : "  (policy " + state.policy.name + " " + state.policy.hash + ")";
      // a first line "# Fix the cart total" is the script's purpose: it goes in the header, not twice
      const lines = source.trim().split("\n");
      const purpose = lines.length > 0 && lines[0].startsWith("#") ? oneLine(lines.shift().replace(/^#+\s*/, "")) : "";
      text += "== " + clock(now) + "  script " + state.auditScript + who + (purpose === "" ? "" : "  " + purpose) + "  (" + status + ", " + state.execution.steps + (state.execution.steps === 1 ? " step)" : " steps)") + under + " ==\n";
      // the script is indented, so no line of it can look like a header (==) or the end of the script (--)
      text += lines.map((line) => ("  " + oneLine(line)).trimEnd()).join("\n") + "\n--\n";
      for (const record of state.auditSteps) {
        text += auditLine(record) + "\n";
      }
      for (const error of errors) {
        text += "!! " + error.line + ":" + error.column + " " + oneLine(error.message.split("\n")[0]) + "\n";
      }
      text += "\n";
    }
    await fs.appendFile(nodePath.join(folder, name), text);
    // a write of ClankTalk's own: the check around a run with no sandbox does not count it
    await untrusted.wroteOwn(nodePath.join(folder, name));
    // "audit also to" in the policy: a copy outside the project, where project tools cannot reach it
    for (const rule of state.policy === null ? [] : state.policy.rules) {
      if (rule.type === "auditAlso") {
        await fs.mkdir(rule.folder, { recursive: true });
        await fs.appendFile(nodePath.join(rule.folder, name), text);
      }
    }
  } catch (err) {
    state.execution.warnings.push({ message: "Could not write the audit: " + err.message, line: 1, column: 1 });
  }
}

// ----- undo -----

// at the end of a script, its file changes go on the undo list, even if it failed part way
// one item for each file: the text before the script, and after it
// "undo" in a script records the script's changes so far first, so it can take them back;
// recordedChanges keeps those from being recorded twice at the end
function recordUndo(state) {
  const byPath = new Map();
  const changes = state.execution.changes.slice(state.recordedChanges);
  state.recordedChanges = state.execution.changes.length;
  for (const change of changes) {
    // undo does not record itself, so there is no redo
    if (change.undo) {
      continue;
    }
    const item = byPath.get(change.path);
    if (item === undefined) {
      byPath.set(change.path, { path: change.path, before: change.before, after: change.after });
    } else {
      item.after = change.after;
    }
  }
  if (byPath.size === 0) {
    return;
  }
  state.undo.push({ time: new Date(), files: [...byPath.values()] });
  while (state.undo.length > UNDO_LIMIT) {
    state.undo.shift();
  }
}

// undo, undo <count>, undo changes to <file>; the result is the paths it put back
async function runUndo(command, state) {
  // the running script's own changes so far are the newest item
  recordUndo(state);
  // the items to take back, newest first: { path, before, after }
  let items = [];
  let entries = [];
  if (command.file !== null) {
    const file = await evaluate(command.file, state);
    if (!(file instanceof FileRef)) {
      throw new ScriptError(notAFile(file), command.file);
    }
    for (let index = state.undo.length - 1; index >= 0 && items.length === 0; index--) {
      for (const item of state.undo[index].files) {
        if (item.path === file.path) {
          items.push(item);
        }
      }
    }
    if (items.length === 0) {
      throw new ScriptError("Undo has no changes to " + file.path, command);
    }
  } else {
    let count = 1;
    if (command.count !== null) {
      count = toNumber(await evaluate(command.count, state), command.count);
      if (!Number.isInteger(count) || count < 1) {
        throw new ScriptError("Undo needs a whole number above 0, found " + count, command.count);
      }
    }
    if (state.undo.length === 0) {
      throw new ScriptError("Nothing to undo", command);
    }
    if (count > state.undo.length) {
      throw new ScriptError("Only " + state.undo.length + " scripts can be undone", command);
    }
    entries = state.undo.slice(state.undo.length - count).reverse();
    for (const entry of entries) {
      items.push(...entry.files);
    }
  }

  // check everything first: each file must be as the script left it,
  // or as a newer item puts it back; if one is not, nothing changes
  const final = new Map();
  const changed = [];
  for (const item of items) {
    let now;
    if (final.has(item.path)) {
      now = final.get(item.path);
    } else {
      now = await currentText(item.path, state);
    }
    if (now !== item.after && !changed.includes(item.path)) {
      changed.push(item.path);
    }
    final.set(item.path, item.before);
  }
  if (changed.length > 0) {
    throw new ScriptError("Cannot undo: these files changed after the script: " + changed.join(", ") + ". Nothing was changed", command);
  }

  // if one file cannot be put back, the files before it go back to how they were, so undo changes all or nothing
  const restored = [];
  const was = [];
  const changesBefore = state.execution.changes.length;
  try {
    for (const [path, text] of final) {
      was.push({ path, text: await currentText(path, state) });
      await restoreFile(path, text, state, command);
      restored.push(path);
    }
  } catch (err) {
    for (const { path, text } of was.reverse()) {
      await putBack(path, text, state);
    }
    state.execution.changes.length = changesBefore;
    const failed = scriptErrorFor(err, command, state);
    if (failed instanceof ScriptError && !(failed instanceof Cancelled) && !(failed instanceof Rejected)) {
      failed.message = "Cannot undo " + was[0].path + ": " + failed.message + ". Nothing was changed";
    }
    throw failed;
  }

  // the items are done: take them off the list
  if (command.file !== null) {
    for (const entry of state.undo) {
      entry.files = entry.files.filter((item) => !items.includes(item));
    }
  } else {
    state.undo.splice(state.undo.length - entries.length, entries.length);
  }
  for (let index = state.undo.length - 1; index >= 0; index--) {
    if (state.undo[index].files.length === 0) {
      state.undo.splice(index, 1);
    }
  }
  return restored;
}

// a raw write for a failed undo: no checks and no hooks, because it puts back what the checks saw
async function putBack(path, text, state) {
  const absolute = nodePath.resolve(state.root, path);
  try {
    if (text === null) {
      await fs.rm(absolute, { force: true });
    } else {
      await fs.writeFile(absolute, text, "utf8");
    }
  } catch {
    // the file cannot be written now either; the error for the undo names the first file
  }
}

// the text of a project file now, or null if it does not exist
async function currentText(path, state) {
  try {
    return await fs.readFile(nodePath.resolve(state.root, path), "utf8");
  } catch (err) {
    return null;
  }
}

// a git step for the audit, in the script's words: { target, details }
function gitShown(op, step, args) {
  if (op === "switch") {
    return { target: "switch to " + (args.includes("--create") ? "new branch " : "") + step.branch, details: "" };
  }
  if (op === "commit") {
    return { target: "commit '" + step.message + "'", details: step.files.length + (step.files.length === 1 ? " file" : " files") };
  }
  if (op === "merge") {
    return { target: "merge " + step.branch, details: "fast-forward" };
  }
  if (op === "rebase") {
    return { target: "rebase onto " + step.branch, details: "" };
  }
  if (op === "delete") {
    return { target: "delete branch " + step.branch, details: "" };
  }
  if (op === "move") {
    return { target: "move " + step.from + " to " + step.to, details: "" };
  }
  if (op === "stash") {
    return { target: args[1] === "pop" ? "stash pop" : "stash", details: "" };
  }
  if (op === "stashes" || op === "tags") {
    return { target: op, details: "" };
  }
  if (op === "tag") {
    return { target: "tag " + step.tag, details: "" };
  }
  if (op === "blame") {
    return { target: "blame " + step.file, details: "" };
  }
  if (op === "restore") {
    return { target: "restore " + step.files.join(", "), details: step.files.length + (step.files.length === 1 ? " file" : " files") };
  }
  if (op === "pull") {
    return { target: "pull origin " + step.branch, details: "fast-forward" };
  }
  if (op === "push" && step.tag !== undefined) {
    return { target: "push tag " + step.tag, details: "" };
  }
  // status, branch, branches, push, diff, log, show: the operation, and what the script named, with no flags
  const named = args.slice(1).filter((arg) => !arg.startsWith("-") && arg !== "HEAD" && arg !== "origin");
  return { target: [op, ...named].join(" "), details: "" };
}

// put a file back to its old text; null removes a file that the script made
// the same checks as a write, and the "undo" and "change" hooks
async function restoreFile(path, text, state, node) {
  const file = new FileRef(nodePath.resolve(state.root, path), state.root);
  checkInsideRoot(file.absolute, state, node, path);
  checkDenied("writes", state, node);
  if (await isProtected(file, state, node)) {
    throw new ScriptError("A script cannot change .talk files or the @/talk folder: " + file.path, node);
  }
  if ((await isHidden(file, state, node)) !== null) {
    throw new ScriptError("A script cannot change hidden files or folders (a name that starts with .): " + file.path, node);
  }
  const step = changeStep("undo", file, { text });
  await changeHooks("before", step, state, node);
  const before = await currentText(path, state);
  if (text === null) {
    await fs.rm(file.absolute, { force: true });
    state.seen.delete(file.absolute);
  } else {
    await makeParentFolders(file, state, node);
    await fs.writeFile(file.absolute, text, "utf8");
    state.seen.set(await fs.realpath(file.absolute), text);
  }
  state.execution.changes.push({ path: file.path, before, after: text, undo: true });
  await changeHooks("after", step, state, node);
}

// the undo list, newest first, for "the undo list"
function undoList(state) {
  const list = [];
  for (let index = state.undo.length - 1; index >= 0; index--) {
    const entry = state.undo[index];
    const files = entry.files.map((item) => item.path);
    list.push(new UndoStep(list.length + 1, entry.time.toTimeString().slice(0, 5), files));
  }
  return list;
}

// ----- hooks -----

// the step for a file change hook: kind, path and more fields
function changeStep(kind, file, fields) {
  const step = Object.create(null);
  step.kind = kind;
  step.path = null;
  if (file instanceof FileRef) {
    step.path = file.path;
  }
  for (const name of Object.keys(fields)) {
    step[name] = fields[name];
  }
  return step;
}

// a file change runs the hooks for its kind (write, replace, ...) and the "change" hooks
// details: what the change did, for the audit; changeDetails gives it for most kinds
async function changeHooks(when, step, state, node, details) {
  if (when === "after") {
    auditStep(state, step.kind, step.path, details !== undefined ? details : changeDetails(step, state));
  }
  await runHooks(when, [step.kind, "change"], step, state, node);
}

// what a file change did, for the audit: "12 lines, new file", "lines 40-52 with 4 lines", "3 lines after line 120"
// each change saves its undo, so the audit does not say so
function changeDetails(step, state) {
  const lines = (n) => n + (n === 1 ? " line" : " lines");
  const range = (from, to) => (from === to ? "line " + from : "lines " + from + "-" + to);
  if (step.kind === "undo") {
    return step.text === null ? "removed" : "put back";
  }
  if (step.kind === "write") {
    const change = lastChange(state, step.path);
    return lines(linesIn(step.text)) + (change !== null && change.before === null ? ", new file" : "");
  }
  if (step.kind === "append") {
    return lines(linesIn(step.text)) + " at the end";
  }
  if (step.kind === "put") {
    return lines(linesIn(step.text)) + " " + step.where + " line " + step.line;
  }
  if (step.kind === "remove") {
    return range(step.from, step.to);
  }
  if (step.kind === "replace" && step.from !== undefined) {
    return range(step.from, step.to) + " with " + lines(linesIn(step.text));
  }
  if (step.kind === "move") {
    return "to " + step.to;
  }
  return "";
}

// the number of lines in a text; a line break at the end does not start a line
function linesIn(text) {
  if (text === null || text === undefined || text === "") {
    return 0;
  }
  const count = text.split("\n").length;
  return text.endsWith("\n") ? count - 1 : count;
}

// the last change to a file in this script, or null
function lastChange(state, path) {
  for (let i = state.execution.changes.length - 1; i >= 0; i--) {
    if (state.execution.changes[i].path === path) {
      return state.execution.changes[i];
    }
  }
  return null;
}

// the lines of the new text that a change touched: "line 40", "lines 40-52", or "" for no change
function changedRange(before, after) {
  const a = (before || "").split("\n");
  const b = (after || "").split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++;
  }
  if (start === a.length && start === b.length) {
    return "";
  }
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const last = Math.max(endB, start);
  return start === last ? "line " + (start + 1) : "lines " + (start + 1) + "-" + (last + 1);
}

// run the hooks for a step, in the order they are defined
// names: the step names a hook can use, for example ["write", "change"]
// commands inside a hook do not run hooks
async function runHooks(when, names, step, state, node) {
  if (state.inHook) {
    return;
  }
  for (const hook of state.hooks) {
    if (hook.when === when && names.includes(hook.name)) {
      await runHook(hook, step, state, node);
    }
  }
}

// a hook has its own local variables: the step, with the name the hook uses
async function runHook(hook, step, state, node) {
  const savedVariables = state.variables;
  const savedResult = state.result;
  const savedHandler = state.handler;
  const savedHandling = state.handling;
  // the hook gets a copy of the step, so it cannot change what runs; see src/md/features/hooks.md
  const locals = Object.create(null);
  setOwn(locals, hook.name, copyValue(step));
  state.variables = locals;
  state.handler = findHandler(hook.body);
  state.handling = false;
  state.inHook = true;
  const savedFile = state.file;
  state.file = hook.file;
  const savedFrom = state.auditFrom;
  state.auditFrom = "hook " + hook.when + " " + hook.name;
  try {
    await runCommands(hook.body, state);
  } catch (err) {
    // a reject points at the command it stopped, so the agent sees where
    if (err instanceof Rejected) {
      throw new Rejected(err.message, node);
    }
    if (err instanceof ScriptError && !err.file) {
      err.file = hook.file;
    }
    throw err;
  } finally {
    state.variables = savedVariables;
    state.result = savedResult;
    state.handler = savedHandler;
    state.handling = savedHandling;
    state.inHook = false;
    state.file = savedFile;
    state.auditFrom = savedFrom;
  }
}

// a deep copy of lists and plain objects; files, lines and secrets cannot change, so they stay as they are
function copyValue(value) {
  let copy = value;
  if (Array.isArray(value)) {
    copy = value.map(copyValue);
  } else if (isPlainObject(value)) {
    copy = Object.create(Object.getPrototypeOf(value));
    for (const [name, item] of Object.entries(value)) {
      setOwn(copy, name, copyValue(item));
    }
  } else {
    return value;
  }
  return copy;
}

// what a "for" loop goes over: a list; null gives no passes
// later: the lines of a file
function loopItems(value, node) {
  if (value === null || value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return flatFiles(value);
  }
  throw new ScriptError("Cannot loop over " + describe(value) + ", expected a list", node);
}

// a list of files, with the files of each glob in it put in place: [@/package.json, @/src/js/*.js]
// a file named twice is there once; a list of other values stays as it is
function flatFiles(value) {
  if (!Array.isArray(value) || !value.some(Array.isArray)) {
    return value;
  }
  const all = [];
  for (const item of value) {
    if (Array.isArray(item)) {
      all.push(...item);
    } else {
      all.push(item);
    }
  }
  if (!all.every((item) => item instanceof FileRef)) {
    return value;
  }
  const seen = new Set();
  return all.filter((file) => {
    if (seen.has(file.absolute)) {
      return false;
    }
    seen.add(file.absolute);
    return true;
  });
}

// the error for a name that no command set; it names a set variable with a close spelling
function unknownVariable(name, scope, pathHint) {
  let message = "Unknown variable '" + name + "'.";
  // read README.md: a file name with no ./ or @/ reads as a variable and a property
  if (pathHint !== undefined) {
    return message + " If " + pathHint + " is a file, write it as a path, with no quotes: @/" + pathHint + " or ./" + pathHint;
  }
  const close = Object.keys(scope).find((other) => editDistance(name, other) <= 2);
  if (close !== undefined) {
    message += " Did you mean '" + close + "'?";
  }
  // a hyphen joins a name, so a-b is one name; for subtraction, spaces are needed
  if (name.includes("-")) {
    const parts = name.split("-");
    message += " For subtraction, put spaces around the minus: " + parts.join(" - ") + ".";
  }
  return message + " Set it before you use it, for example: set " + name + " to 0";
}

// how many letters to add, remove or change to make one word from the other
function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const change = a[i - 1] === b[j - 1] ? 0 : 1;
      current.push(Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + change));
    }
    previous = current;
  }
  return previous[b.length];
}

// $name is a global, any other name is local to the script
function scopeFor(name, state) {
  if (name.startsWith("$")) {
    return state.globals;
  }
  return state.variables;
}

// set a variable, a property or an index
async function assign(target, value, state) {
  if (target.type === "result") {
    state.result = value;
    return;
  }
  if (target.type === "variable") {
    const scope = scopeFor(target.name, state);
    setOwn(scope, target.name, value);
    return;
  }

  const object = await evaluate(target.object, state);
  let name = target.name;
  if (target.type === "index") {
    name = await evaluate(target.index, state);
  }

  if (object === null || typeof object !== "object") {
    throw new ScriptError("Cannot set '" + name + "' on " + describe(object), target);
  }
  // files and lines cannot change this way
  if (object instanceof FileRef || object instanceof Line) {
    throw new ScriptError("Cannot set '" + name + "' on a " + (object instanceof FileRef ? "file" : "line"), target);
  }
  if (typeof name !== "string" && typeof name !== "number") {
    throw new ScriptError("A property name must be text or a number", target);
  }
  // a list has items from 0 to its length; set at the length adds an item
  if (Array.isArray(object) && !(Number.isInteger(name) && name >= 0 && name <= object.length)) {
    throw new ScriptError("A list index must be a whole number from 0 to " + object.length + " (the length of the list), not " + describe(name), target);
  }
  // a value that holds itself has no end, so it cannot print or become json
  if (holds(value, object, new Set())) {
    throw new ScriptError("Cannot set '" + name + "': the value holds the list or object that it goes into", target);
  }
  // some fields cannot change, for example the length of a list
  try {
    setOwn(object, name, value);
  } catch (err) {
    throw new ScriptError("Cannot set '" + name + "'", target);
  }
}

// true if value is target, or holds it at any depth
function holds(value, target, seen) {
  if (value === target) {
    return true;
  }
  if (value === null || typeof value !== "object" || seen.has(value) || !(Array.isArray(value) || isPlainObject(value))) {
    return false;
  }
  seen.add(value);
  return Object.values(value).some((item) => holds(item, target, seen));
}

// defineProperty always makes a plain own field, even for names like __proto__
function setOwn(object, name, value) {
  Object.defineProperty(object, name, { value, writable: true, enumerable: true, configurable: true });
}

// only plain data: no access to JavaScript internals such as constructor or __proto__
function getProperty(object, name, node) {
  if (object === null || object === undefined) {
    return null;
  }
  if (object instanceof Secret) {
    throw new SecretUse(object, "'" + name + "'");
  }
  if (typeof object !== "object" && typeof object !== "string") {
    return null;
  }
  if (typeof name !== "string" && typeof name !== "number") {
    throw new ScriptError("A property name must be text or a number", node);
  }
  if (!Object.hasOwn(object, name) && !(typeof object === "string" && name === "length")) {
    return null;
  }
  const value = object[name];
  if (typeof value === "function") {
    return null;
  }
  return value;
}

// the first or last item of a list, or null when the list is empty
function firstOrLast(list, name) {
  if (list.length === 0) {
    return null;
  }
  if (name === "first") {
    return list[0];
  }
  return list[list.length - 1];
}

function evaluateUnary(node, value) {
  if (node.operator === "not") {
    return !isTrue(value);
  }
  if (node.operator === "no") {
    return isEmpty(value);
  }
  if (node.operator === "-") {
    return -toNumber(value, node);
  }
  throw new ScriptError("Unknown operator '" + node.operator + "'", node);
}

function evaluateCheck(node, value) {
  if (node.operator === "exists") {
    return value !== null && value !== undefined;
  }
  if (node.operator === "does not exist") {
    return value === null || value === undefined;
  }
  if (node.operator === "is empty") {
    return isEmpty(value);
  }
  if (node.operator === "is not empty") {
    return !isEmpty(value);
  }
  throw new ScriptError("Unknown operator '" + node.operator + "'", node);
}

function evaluateBinary(node, left, right) {
  const op = node.operator;

  if (op === "+") {
    if (left instanceof Secret || right instanceof Secret) {
      return Secret.join(left, right);
    }
    if (typeof left === "string" || typeof right === "string") {
      return toText(left) + toText(right);
    }
    return finite(toNumber(left, node) + toNumber(right, node), node);
  }
  if (op === "-") {
    return finite(toNumber(left, node) - toNumber(right, node), node);
  }
  if (op === "*") {
    return finite(toNumber(left, node) * toNumber(right, node), node);
  }
  if (op === "/") {
    const divisor = toNumber(right, node);
    if (divisor === 0) {
      throw new ScriptError("Division by zero", node);
    }
    return finite(toNumber(left, node) / divisor, node);
  }
  if (op === "mod") {
    const divisor = toNumber(right, node);
    if (divisor === 0) {
      throw new ScriptError("Division by zero", node);
    }
    return toNumber(left, node) % divisor;
  }

  if (op === "is") {
    return sameValue(left, right);
  }
  if (op === "is not") {
    return !sameValue(left, right);
  }
  if (op === "is less than") {
    return compared(left, node) < compared(right, node);
  }
  if (op === "is greater than") {
    return compared(left, node) > compared(right, node);
  }
  if (op === "is less than or equal to") {
    return compared(left, node) <= compared(right, node);
  }
  if (op === "is greater than or equal to") {
    return compared(left, node) >= compared(right, node);
  }

  if (op === "contains") {
    return contains(left, right, node);
  }
  if (op === "does not contain") {
    return !contains(left, right, node);
  }
  if (op === "is in") {
    return contains(right, left, node);
  }
  if (op === "is not in") {
    return !contains(right, left, node);
  }
  // null is no value, so no text starts or ends with it, and it starts with nothing
  if (op === "starts with") {
    return left !== null && right !== null && toText(left).startsWith(toText(right));
  }
  if (op === "ends with") {
    return left !== null && right !== null && toText(left).endsWith(toText(right));
  }
  if (op === "does not start with") {
    return !(left !== null && right !== null && toText(left).startsWith(toText(right)));
  }
  if (op === "does not end with") {
    return !(left !== null && right !== null && toText(left).endsWith(toText(right)));
  }

  throw new ScriptError("Unknown operator '" + op + "'", node);
}

function convert(node, value) {
  if (node.to === "json") {
    if (typeof value === "string") {
      try {
        return JSON.parse(value);
      } catch (err) {
        throw new ScriptError("Not valid JSON: " + err.message, node);
      }
    }
    return JSON.stringify(value);
  }
  if (node.to === "pretty json") {
    return JSON.stringify(value, null, 2);
  }
  if (node.to === "number") {
    return toNumber(value, node);
  }
  if (node.to === "text") {
    return toText(value);
  }
  throw new ScriptError("Unknown conversion '" + node.to + "'", node);
}

// ----- files -----
//
// Every path is checked against the project root, before and after
// symlinks are followed. Nothing outside the root can be read.

// operators that use the text of a file or a line
const TEXT_OPERATORS = ["contains", "does not contain", "starts with", "ends with", "does not start with", "does not end with", "is in", "is not in"];

// contains and is in on a list compare items, so a file in the list stays a file
function inList(op, left, right) {
  if (op === "contains" || op === "does not contain") {
    return Array.isArray(left);
  }
  if (op === "is in" || op === "is not in") {
    return Array.isArray(right);
  }
  return false;
}

// is, contains and is in: a file is the same as a file with the same path; a line is its text
// other values are the same only if they are equal (1 is not '1'), and lists and objects only if they are one
function sameValue(left, right) {
  if (left instanceof FileRef && right instanceof FileRef) {
    return left.absolute === right.absolute;
  }
  if (left instanceof Line) {
    left = left.text;
  }
  if (right instanceof Line) {
    right = right.text;
  }
  // lists and objects are the same if their content is the same, at any depth
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => sameValue(item, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const names = Object.keys(left);
    return names.length === Object.keys(right).length && names.every((name) => Object.hasOwn(right, name) && sameValue(left[name], right[name]));
  }
  return left === right;
}

// a part of + or ${}: a file is its path, a line is its text, other values stay as they are
function joinPart(value) {
  if (value instanceof FileRef) {
    return value.path;
  }
  if (value instanceof Line) {
    return value.text;
  }
  return value;
}

// a file or a line gives its text, any other value stays as it is
async function asText(value, state, node) {
  if (value instanceof FileRef) {
    return await readText(value, state, node);
  }
  if (value instanceof Line) {
    return value.text;
  }
  return value;
}

// ./x and ../x are relative to cwd, @/x to the root
// a path with * or ? in it is a glob, and gives a list of files
async function resolvePath(text, state, node) {
  let base = state.cwd;
  let rest = text;
  if (text.startsWith("@/")) {
    base = state.root;
    rest = text.slice(2);
  }

  if (rest.includes("*") || rest.includes("?")) {
    return await globFiles(base, rest, state, node);
  }

  const absolute = nodePath.resolve(base, rest);
  checkInsideRoot(absolute, state, node, text);
  return new FileRef(absolute, state.root, rest.endsWith("/"));
}

// <path or file> is in <folder>: true if the path is inside the folder, at any depth
// a text path is from the project root, as in the change's path; see src/md/features/language.md
// both paths are compared as real paths, so a link or a change of letter case cannot get past a hook
async function inFolder(left, folder, node) {
  if (left === null) {
    return false;
  }
  let absolute;
  if (left instanceof FileRef) {
    absolute = left.absolute;
  } else if (typeof left === "string") {
    absolute = nodePath.resolve(folder.root, left);
  } else {
    throw new ScriptError("'is in' a folder needs a path or a file, found " + describe(left), node.left);
  }
  const path = await canonicalPath(absolute);
  const inside = await canonicalPath(folder.absolute);
  return path !== inside && isInside(path, inside);
}

// macOS and Windows file systems ignore letter case by default, so paths there are compared in lower case
const FOLD_CASE = process.platform === "darwin" || process.platform === "win32";

// a path to compare: links followed for the part that exists, Unicode in one form (NFC), and lower case where
// the file system ignores case
async function canonicalPath(absolute) {
  let existing = absolute;
  const rest = [];
  let real = null;
  while (real === null) {
    try {
      real = nodePath.join(await fs.realpath(existing), ...rest);
    } catch (err) {
      const parent = nodePath.dirname(existing);
      if (parent === existing) {
        real = absolute;
      } else {
        rest.unshift(nodePath.basename(existing));
        existing = parent;
      }
    }
  }
  const normal = real.normalize("NFC");
  return FOLD_CASE ? normal.toLowerCase() : normal;
}

// a path written with a / at the end, or a folder that exists
async function isFolder(file) {
  if (file.folder) {
    return true;
  }
  try {
    return (await fs.stat(file.absolute)).isDirectory();
  } catch (err) {
    return false;
  }
}

// the parts of a glob before its first wildcard, such as dist/lib for dist/lib/**/*.js
function fixedPart(pattern) {
  const fixed = [];
  for (const part of pattern.split("/")) {
    if (/[*?[{]/.test(part)) {
      break;
    }
    fixed.push(part);
  }
  return fixed.join("/");
}

// the files and folders that git ignores, as absolute paths, with the hardened git;
// no git, not a repo, or a repo config that can run programs: none, so a glob skips nothing
async function gitIgnored(state, node) {
  const env = gitEnv(process.env);
  try {
    const config = await spawnProgram("git", [...guardArgs(), "config", "list", "--show-scope"], state.root, env, state.timeLimit, state, node);
    if (config.code !== 0 || unsafeConfig(config.output).length > 0) {
      return new Set();
    }
    const listed = await spawnProgram("git", [...guardArgs(), "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], state.root, env, state.timeLimit, state, node);
    if (listed.code !== 0) {
      return new Set();
    }
    const entries = listed.output.split("\0").filter((entry) => entry !== "");
    return new Set(entries.map((entry) => nodePath.resolve(state.root, entry)));
  } catch (err) {
    if (err instanceof Cancelled) {
      throw err;
    }
    return new Set();
  }
}

async function globFiles(base, pattern, state, node) {
  // a glob skips .git, and what git ignores, unless the fixed part of the pattern names it:
  // @/**/*.js skips an ignored dist/, but @/dist/**/*.js looks in it
  const namesGit = pattern.split("/").includes(".git");
  const ignored = await gitIgnored(state, node);
  const fixed = nodePath.resolve(base, fixedPart(pattern));
  // a glob that leaves the root fails before it looks, so the error does not tell what is outside
  const parts = pattern.split("/");
  const wild = parts.findIndex((part) => /[*?[{]/.test(part));
  checkInsideRoot(fixed, state, node, pattern);
  if (wild !== -1 && parts.slice(wild).includes("..")) {
    throw new ScriptError("A glob cannot have '..' after a wildcard: " + pattern, node);
  }
  // fs.glob calls exclude for each file and folder, so a skipped folder is not walked
  const exclude = (path) => {
    const absolute = nodePath.resolve(base, path);
    if ((nodePath.basename(absolute) === ".git" || nodePath.basename(absolute) === ".talk") && !namesGit) {
      return true;
    }
    return ignored.has(absolute) && !isInside(fixed, absolute);
  };
  const files = [];
  for await (const match of fs.glob(pattern, { cwd: base, exclude })) {
    const absolute = nodePath.resolve(base, match);
    checkInsideRoot(absolute, state, node, pattern);
    // a link that points to nothing, or to a file outside the root, is not in the list
    const stats = await fs.stat(absolute).catch(() => null);
    if (stats === null) {
      continue;
    }
    const real = await fs.realpath(absolute);
    if (!isInside(real, await fs.realpath(state.root))) {
      continue;
    }
    // .env files are left out, since a script cannot read them
    if (stats.isFile() && !isSecretFile(absolute) && !isSecretFile(real)) {
      files.push(new FileRef(absolute, state.root));
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

// list <folder>: the files and folders in it, by name, folders marked; list all of <folder>: every file below it
// the same as a glob leaves out: .git, .talk, what git ignores, .env files, and links that leave the root
async function listFolder(folder, all, state, node) {
  if (!(folder instanceof FileRef)) {
    throw new ScriptError("list needs a folder, such as @/ or @/notes/, found " + describe(folder), node);
  }
  const stats = await fs.stat(folder.absolute).catch(() => null);
  if (stats === null || !stats.isDirectory()) {
    throw new ScriptError((folder.path === "" ? "@/" : folder.path) + " is not a folder. list takes a folder, such as @/notes/", node);
  }
  const prefix = folder.path === "" ? "" : folder.path + "/";
  if (all) {
    return await globFiles(state.root, prefix + "**/*", state, node);
  }
  const ignored = await gitIgnored(state, node);
  const realRoot = await fs.realpath(state.root);
  const entries = [];
  for (const entry of await fs.readdir(folder.absolute, { withFileTypes: true })) {
    const absolute = nodePath.join(folder.absolute, entry.name);
    if (entry.name === ".git" || entry.name === ".talk" || ignored.has(absolute) || isSecretFile(absolute)) {
      continue;
    }
    const entryStats = await fs.stat(absolute).catch(() => null);
    if (entryStats === null || !isInside(await fs.realpath(absolute), realRoot)) {
      continue;
    }
    entries.push(new FileRef(absolute, state.root, entryStats.isDirectory()));
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  auditStep(state, "list", prefix === "" ? "@/" : prefix, entries.length + (entries.length === 1 ? " entry" : " entries"));
  return entries;
}

function isInside(absolute, root) {
  const relative = nodePath.relative(root, absolute);
  return !relative.startsWith("..") && !nodePath.isAbsolute(relative);
}

function checkInsideRoot(absolute, state, node, shown) {
  if (!isInside(absolute, state.root)) {
    throw new ScriptError("Path is outside the project root: " + shown, node);
  }
}

// the real path of an existing file, after symlinks; null if it does not exist
async function realPath(file, state, node) {
  let real;
  try {
    real = await fs.realpath(file.absolute);
  } catch (err) {
    if (err.code === "ENOENT") {
      return null;
    }
    throw new ScriptError("Cannot open " + file.path + ": " + (SYSTEM_ERRORS[err.code] || "system error") + " (" + err.code + ")", node);
  }
  const realRoot = await fs.realpath(state.root);
  if (!isInside(real, realRoot)) {
    throw new ScriptError("Path is outside the project root: " + file.path, node);
  }
  return real;
}

// exists: false for a missing file, and also for a link to a file outside the root,
// so a script cannot learn what is outside the root
async function fileExists(file, state, node) {
  try {
    return (await realPath(file, state, node)) !== null;
  } catch (err) {
    if (err instanceof ScriptError && err.message.startsWith("Path is outside the project root")) {
      return false;
    }
    // a link to itself, or a path through a file, cannot be there
    if (err instanceof ScriptError && /\((ELOOP|ENOTDIR|ENAMETOOLONG)\)$/.test(err.message)) {
      return false;
    }
    throw err;
  }
}

// the error for a value that is not a file; text that looks like a path gets the path form
function notAFile(value) {
  if (typeof value === "string" && /^(\.\.?\/|@\/|~\/)|^[\w.-]+\/|\.[A-Za-z0-9]{1,5}$/.test(value)) {
    return "Expected a file, found the text " + describe(value) + ". Write the path with no quotes: " + (/^(\.\.?\/|@\/)/.test(value) ? value : "@/" + value);
  }
  return "Expected a file, found " + describe(value);
}

// a folder is not a file: name it, and show how to get its files
function folderError(file) {
  const shown = file.path === "" ? "@/" : file.path + "/";
  return shown + " is a folder, not a file. For its files, use a glob: for f in " + (shown === "@/" ? "@/" : "@/" + shown) + "**/*";
}

async function readText(file, state, node) {
  if (!(file instanceof FileRef)) {
    throw new ScriptError(notAFile(file), node);
  }
  const real = await realPath(file, state, node);
  if (real === null) {
    throw new ScriptError("File not found: " + file.path, node);
  }
  // by the path as written and the path after links, so a link to a .env file is refused too
  if (isSecretFile(file.path) || isSecretFile(real)) {
    throw new ScriptError("A script cannot read .env files, because they hold secrets: " + file.path, node);
  }
  const stats = await fs.stat(real);
  if (!stats.isFile()) {
    throw new ScriptError(stats.isDirectory() ? folderError(file) : "Not a file: " + file.path, node);
  }
  const step = Object.create(null);
  step.path = file.path;
  await runHooks("before", ["read"], step, state, node);
  const raw = await fs.readFile(real, "utf8");
  // remember what is on disk, for the stale-write check; the script sees the text without a BOM
  state.seen.set(real, raw);
  const text = withoutBom(raw);
  step.text = text;
  auditRead(state, file.path);
  await runHooks("after", ["read"], step, state, node);
  return text;
}

// the UTF-8 byte order mark that some editors put at the start of a file
const BOM = String.fromCharCode(0xfeff);

function withoutBom(text) {
  return text.startsWith(BOM) ? text.slice(1) : text;
}

function lineCount(count) {
  return count + (count === 1 ? " line" : " lines");
}

// .env, .env.* and .envrc (direnv) in any folder hold secrets, so scripts cannot read them; see src/md/features/secrets.md
function isSecretFile(path) {
  const name = nodePath.basename(path);
  return name === ".env" || name.startsWith(".env.") || name === ".envrc";
}

// write or append text to a file, and record the change
// change lines from..to (from 1, both ends included) to newText; null removes them
// an empty range (to is from - 1) puts the text in just before line "from"
// putLine is the line that put names, for its range check
// gives back the old lines
async function editLines(file, from, to, newText, state, node, putLine) {
  if (!(file instanceof FileRef)) {
    throw new ScriptError("A line edit needs a file, found " + describe(file), node);
  }
  const real = await realPath(file, state, node);
  if (real === null) {
    throw new ScriptError("File not found: " + file.path, node);
  }
  // line numbers come from an earlier read, so a line edit needs one
  if (!state.seen.has(real)) {
    throw new ScriptError("Read " + file.path + " before a line edit, so the line numbers are known", node);
  }
  const text = await fs.readFile(real, "utf8");
  if (text !== state.seen.get(real)) {
    throw new ScriptError("File changed since it was read: " + file.path + ". Read it again", node);
  }

  // a BOM is not a part of line 1; writeText puts it back
  const parts = withoutBom(text).split("\n");
  const finalBreak = parts.length > 0 && parts[parts.length - 1] === "";
  if (finalBreak) {
    parts.pop();
  }
  const count = parts.length;
  // an empty file: put before line 1, or after line 0, adds the first line
  const firstLine = count === 0 && from === 1 && (putLine === 0 || putLine === 1);
  if (putLine !== undefined) {
    if (!firstLine && (!Number.isInteger(putLine) || putLine < 1 || putLine > count)) {
      throw new ScriptError("Line " + putLine + " is not in " + file.path + ", which has " + lineCount(count), node);
    }
  } else if (Number.isInteger(from) && Number.isInteger(to) && from > to) {
    throw new ScriptError("Lines " + from + " to " + to + " are in the wrong order. Write the smaller number first", node);
  } else if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > count) {
    throw new ScriptError("Lines " + from + " to " + to + " are not in " + file.path + ", which has " + lineCount(count), node);
  }

  // a file with CRLF line breaks keeps them: each part keeps its "\r", and new lines get one
  const firstBreak = text.indexOf("\n");
  const crlf = firstBreak > 0 && text[firstBreak - 1] === "\r";
  let newParts = [];
  if (newText !== null) {
    newParts = newText.split("\n");
    // a final line break in the new text does not make an extra empty line
    // but empty text is one empty line; "remove lines" takes lines away
    if (newParts.length > 1 && newParts[newParts.length - 1] === "") {
      newParts.pop();
    }
    newParts = newParts.map((part) => part.replace(/\r$/, "") + (crlf ? "\r" : ""));
  }
  const old = parts.splice(from - 1, to - from + 1, ...newParts);
  // the last line of a file with no final line break has no "\r" either
  if (!finalBreak && parts.length > 0) {
    parts[parts.length - 1] = parts[parts.length - 1].replace(/\r$/, "");
  }
  let result = parts.join("\n");
  if (finalBreak && parts.length > 0) {
    result += "\n";
  }
  await writeText(file, result, false, state, node);

  const oldLines = [];
  for (let index = 0; index < old.length; index++) {
    oldLines.push(new Line(from + index, old[index].replace(/\r$/, "")));
  }
  return oldLines;
}

async function writeText(file, text, append, state, node) {
  await checkWritable(file, state, node);
  let real = await realPath(file, state, node);
  let before = null;
  if (real !== null) {
    const stats = await fs.stat(real);
    if (!stats.isFile()) {
      throw new ScriptError(stats.isDirectory() ? folderError(file) : "Not a file: " + file.path, node);
    }
    // a file that is not UTF-8 would lose bytes, and undo could not put them back
    const bytes = await fs.readFile(real);
    before = bytes.toString("utf8");
    if (!Buffer.from(before, "utf8").equals(bytes)) {
      throw new ScriptError("A script cannot change " + file.path + ", because it is not UTF-8 text", node);
    }
    // stale-write check: the file changed after this script read it
    // append is not checked, because it keeps what is in the file
    if (!append && state.seen.has(real) && state.seen.get(real) !== before) {
      throw new ScriptError("File changed since it was read: " + file.path + ". Read it again", node);
    }
  } else {
    await makeParentFolders(file, state, node);
    real = file.absolute;
  }

  let after = text;
  if (append && before !== null) {
    after = before + text;
  } else if (before !== null && before.startsWith(BOM) && !after.startsWith(BOM)) {
    // a file that had a BOM keeps it; reads do not show it
    after = BOM + after;
  }
  await fs.writeFile(real, after, "utf8");
  state.seen.set(await fs.realpath(real), after);
  state.execution.changes.push({ path: file.path, before, after });
}

// the checks before a script changes a file: one file, writes not denied, not protected, not hidden
async function checkWritable(file, state, node) {
  if (Array.isArray(file)) {
    throw new ScriptError("Expected one file, found a list of " + file.length + ". Use a for loop", node);
  }
  if (!(file instanceof FileRef)) {
    throw new ScriptError(notAFile(file), node);
  }
  checkDenied("writes", state, node);
  if (await isProtected(file, state, node)) {
    throw new ScriptError("A script cannot change .talk files or the @/talk folder: " + file.path, node);
  }
  const hidden = await isHidden(file, state, node);
  if (hidden !== null) {
    throw new ScriptError(
      "A script cannot change hidden files or folders (a name that starts with .): " + file.path + "\n" +
      "To allow this, a human can add this line to AGENTS.talk:\n" +
      "  " + allowLineFor(hidden),
      node,
    );
  }
}

// delete <file>: one file, with the checks of a write; undo puts it back
// a link is removed itself, not the file it points to
async function deleteFile(file, state, node) {
  await checkWritable(file, state, node);
  const real = await realPath(file, state, node);
  if (real === null) {
    throw new ScriptError("Cannot delete " + file.path + ": there is no such file", node);
  }
  if (!(await fs.stat(real)).isFile()) {
    throw new ScriptError("delete takes one file, and " + file.path + " is not a file", node);
  }
  const step = changeStep("delete", file, {});
  await changeHooks("before", step, state, node);
  const text = await fs.readFile(real, "utf8");
  await fs.rm(file.absolute);
  state.seen.delete(real);
  state.execution.changes.push({ path: file.path, before: text, after: null });
  await changeHooks("after", step, state, node);
}

// move <file> to <file>: one file, with the checks of a write for both paths; undo can take it back
// it never replaces a file: the target must not exist
async function moveFile(from, to, state, node) {
  await checkWritable(from, state, node);
  await checkWritable(to, state, node);
  const real = await realPath(from, state, node);
  if (real === null) {
    throw new ScriptError("Cannot move " + from.path + ": there is no such file", node);
  }
  if (!(await fs.stat(real)).isFile()) {
    throw new ScriptError("move takes one file, and " + from.path + " is not a file", node);
  }
  if ((await realPath(to, state, node)) !== null) {
    throw new ScriptError("Cannot move " + from.path + " to " + to.path + ": that file is already there. move does not replace files", node);
  }
  const step = changeStep("move", from, { to: to.path });
  await changeHooks("before", step, state, node);
  // the target is a change too, so a hook for a folder also sees a move into it
  const target = changeStep("move", to, { from: from.path, to: to.path });
  await runHooks("before", ["move", "change"], target, state, node);
  const text = await fs.readFile(real, "utf8");
  await makeParentFolders(to, state, node);
  await fs.rename(real, to.absolute);
  state.seen.delete(real);
  state.seen.set(await fs.realpath(to.absolute), text);
  // two changes, so undo puts the text back at the old path, and removes the new one
  state.execution.changes.push({ path: from.path, before: text, after: null });
  state.execution.changes.push({ path: to.path, before: null, after: text });
  await changeHooks("after", step, state, node);
  await runHooks("after", ["move", "change"], target, state, node);
}

// is this file AGENTS.talk, by name (any case) or by being the same file on disk (a link to it)?
// a protected path, relative to the root: any .talk file, anything in talk/ (extensions),
// or anything in .talk/ (the audit and the untrusted inputs); no allow line can open these
// letter case does not matter, because some file systems ignore it
export function isProtectedPath(relative) {
  const lower = relative.toLowerCase();
  return lower.endsWith(".talk") || lower === "talk" || lower.startsWith("talk/") || lower.startsWith(".talk/");
}

// scripts cannot change .talk files or the @/talk folder, so an agent cannot change its own tools
// the check uses the path as written, the path after symlinks, and for AGENTS.talk
// also the file on disk, so a hard link to it is refused too
async function isProtected(file, state, node) {
  if (isProtectedPath(file.path)) {
    return true;
  }
  const { real, relative } = await realTarget(file, state, node);
  if (isProtectedPath(relative)) {
    return true;
  }
  // if .talk/ is a link (a program with no sandbox can make one), its real target is protected too
  try {
    const talk = await fs.realpath(nodePath.join(state.root, ".talk"));
    if (real === talk || real.startsWith(talk + nodePath.sep)) {
      return true;
    }
  } catch (err) {
    // no .talk/: nothing to add
  }
  try {
    const target = await fs.stat(real);
    const agents = await fs.stat(nodePath.join(state.root, AGENTS_TALK));
    return target.dev === agents.dev && target.ino === agents.ino;
  } catch (err) {
    return false;
  }
}

// true if a part of the path starts with ".": .env, .git/config, .github/workflows/ci.yml
function isHiddenPath(relative) {
  for (const part of relative.split("/")) {
    if (part.startsWith(".") && part !== "." && part !== "..") {
      return true;
    }
  }
  return false;
}

// scripts cannot change hidden files or folders: they hold secrets (.env),
// and config that runs code (.git/hooks, .github/workflows, .claude, .mcp.json)
// "allow changes to" in AGENTS.talk can allow some of them
// the check uses the path as written, and the real path after symlinks;
// for a new file, the real path of its nearest folder that exists, plus the rest
// gives the refused path, relative to the root, or null if the change is allowed
async function isHidden(file, state, node) {
  if (isHiddenPath(file.path) && !isAllowedChange(file.path, state)) {
    return file.path;
  }
  const { relative } = await realTarget(file, state, node);
  if (isHiddenPath(relative) && !isAllowedChange(relative, state)) {
    return relative;
  }
  return null;
}

// the smallest "allow changes to" line for a hidden path: the path up to its first hidden part
// .github/workflows/ci.yml gives @/.github/, and .gitignore gives @/.gitignore
function allowLineFor(relative) {
  const parts = relative.split("/");
  const kept = [];
  for (let index = 0; index < parts.length; index++) {
    kept.push(parts[index]);
    if (parts[index].startsWith(".") && parts[index] !== "." && parts[index] !== "..") {
      const isFolder = index < parts.length - 1;
      return "allow changes to @/" + kept.join("/") + (isFolder ? "/" : "");
    }
  }
  return "allow changes to @/" + relative;
}

// true if "allow changes to" lists the path, or a folder that holds it
function isAllowedChange(relative, state) {
  for (const allowed of state.allowedChanges) {
    if (relative === allowed || relative.startsWith(allowed + "/")) {
      return true;
    }
  }
  return false;
}

// make missing parent folders for a new file
// the nearest folder that exists must be inside the root after symlinks,
// so a symlinked folder cannot lead a new file outside the root
async function makeParentFolders(file, state, node) {
  await realTarget(file, state, node);
  await fs.mkdir(nodePath.dirname(file.absolute), { recursive: true });
}

// where a write really goes, after symlinks, also for a new file:
// the real path of its nearest part that exists, plus the rest; it must be inside the root
// a link that points to nothing is refused: a write follows it to a place no check saw
// gives { real, relative }, relative to the real root
async function realTarget(file, state, node) {
  let existing = file.absolute;
  while (true) {
    try {
      await fs.stat(existing);
      break;
    } catch (err) {
      let isLink = false;
      try {
        isLink = (await fs.lstat(existing)).isSymbolicLink();
      } catch (lstatErr) {
        isLink = false;
      }
      if (isLink) {
        throw new ScriptError("A script cannot write through a link that points to nothing: " + file.path, node);
      }
      existing = nodePath.dirname(existing);
    }
  }
  const real = nodePath.join(await fs.realpath(existing), nodePath.relative(existing, file.absolute));
  const realRoot = await fs.realpath(state.root);
  if (!isInside(real, realRoot)) {
    throw new ScriptError("Path is outside the project root: " + file.path, node);
  }
  return { real, relative: relativeName(realRoot, real) };
}

// replace in one file, with the change hooks; gives the replacements
async function replaceInFile(file, old, replacement, state, command, once = false) {
  // hooks see the pattern's text as old
  const step = changeStep("replace", file, { old: old instanceof Pattern ? old.source : old, new: replacement });
  await changeHooks("before", step, state, command);
  const before = await readText(file, state, command);
  const { text, replacements } = await replaceIn(before, old, replacement, state, command);
  if (once) {
    checkOnce(replacements, file.path, command);
  }
  // a replace that gives the same text writes nothing, so undo does not get a step that changes nothing
  if (replacements.length > 0 && text !== before) {
    await writeText(file, text, false, state, command);
  }
  const count = replacements.length === 1 ? "1 match" : replacements.length + " matches";
  const where = changedRange(before, text);
  await changeHooks("after", step, state, command, replacements.length === 0 ? "no match" : count + (where === "" ? "" : ", " + where));
  return replacements;
}

// a text block in replace is one code edit, so it must match one place; see src/md/features/language.md
function checkOnce(replacements, where, node) {
  if (replacements.length === 1) {
    return;
  }
  if (replacements.length === 0) {
    throw new ScriptError("The text block matches no place in " + where + ". The old text must be exactly as it is there, with its spaces. Read it again", node);
  }
  const lines = replacements.map((found) => found.line).join(", ");
  throw new ScriptError("The text block matches " + replacements.length + " places in " + where + " (lines " + lines + "). It must match one place. Make the old text longer, or write replace every", node);
}

// a replace that finds nothing is often a mistake, such as a wrong line break or indent
// it is a warning, not an error, so "if the result is empty" still works
function warnIfNoMatch(replacements, old, where, state, node) {
  if (replacements.length > 0) {
    return;
  }
  const shown = old instanceof Pattern ? "pattern " + describe(old.source) : describe(old);
  const warning = { message: "No match in " + where + " for " + shown, line: node.line, column: node.column };
  if (state.file) {
    warning.file = state.file;
  }
  state.execution.warnings.push(warning);
}

// replace text or a pattern; a pattern's new text can use $1, $<name>, $& and $$
async function replaceIn(text, old, replacement, state, node) {
  if (!(old instanceof Pattern)) {
    return replaceAll(text, old, replacement);
  }
  const answer = await patternJob({ kind: "replace", source: old.source, flags: old.flags, text, replacement }, state, node);
  const replacements = [];
  for (const found of answer.replacements) {
    const before = text.slice(0, found.index);
    const line = before.split("\n").length;
    const column = found.index - before.lastIndexOf("\n");
    replacements.push({ line, column, old: found.old, new: found.new });
  }
  return { text: answer.text, replacements };
}

// replace every match, and list where each one was in the old text
function replaceAll(text, old, replacement) {
  const replacements = [];
  let index = text.indexOf(old);
  while (index !== -1) {
    const before = text.slice(0, index);
    const line = before.split("\n").length;
    const column = index - before.lastIndexOf("\n");
    replacements.push({ line, column, old, new: replacement });
    index = text.indexOf(old, index + old.length);
  }
  return { text: text.split(old).join(replacement), replacements };
}

async function fileProperty(file, name, state, node) {
  if (name === "name") {
    return file.name;
  }
  if (name === "path") {
    return file.path;
  }
  if (name === "text") {
    return await readText(file, state, node);
  }
  if (name === "lines") {
    return splitLines(await readText(file, state, node));
  }
  if (name === "first" || name === "last") {
    return firstOrLast(splitLines(await readText(file, state, node)), name);
  }
  if (name === "size" || name === "modified") {
    const real = await realPath(file, state, node);
    if (real === null) {
      throw new ScriptError("File not found: " + file.path, node);
    }
    const stats = await fs.stat(real);
    if (name === "size") {
      return stats.size;
    }
    return stats.mtime.toISOString();
  }
  return null;
}

// ----- value helpers -----

function contains(container, item, node) {
  if (typeof container === "string") {
    return item !== null && container.includes(toText(item));
  }
  if (Array.isArray(container)) {
    return container.some((each) => sameValue(each, item));
  }
  if (container === null || container === undefined) {
    return false;
  }
  throw new ScriptError("'contains' needs text or a list", node);
}

function isEmpty(value) {
  if (value === null || value === undefined) {
    return true;
  }
  if (typeof value === "string" || Array.isArray(value)) {
    return value.length === 0;
  }
  if (typeof value === "object") {
    return Object.keys(value).length === 0;
  }
  return false;
}

// false, null, 0, "", empty lists and empty objects are false, everything else is true
function isTrue(value) {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isPlainObject(value)) {
    return Object.keys(value).length > 0;
  }
  return Boolean(value);
}

// < > <= >= compare numbers only; text that holds a number counts as a number, as in math
function compared(value, node) {
  try {
    return toNumber(value, node);
  } catch {
    throw new ScriptError("A comparison such as < needs numbers, and " + describe(value) + " is not a number", node);
  }
}

// null would leave as the text "null", which is almost always a wrong variable
function notNull(value, message, node) {
  if (value === null || value === undefined) {
    throw new ScriptError(message, node);
  }
  return value;
}

// math with very large numbers gives Infinity or NaN, which are not numbers for a script
function finite(number, node) {
  if (!Number.isFinite(number)) {
    throw new ScriptError("The result is too large to be a number", node);
  }
  return number;
}

function toNumber(value, node) {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  throw new ScriptError("Expected a number, found " + describe(value), node);
}

// the lines of a file or a text, each with number and text
async function linesOf(target, state, node) {
  if (target instanceof FileRef) {
    return splitLines(await readText(target, state, node));
  }
  if (typeof target === "string") {
    return splitLines(target);
  }
  throw new ScriptError("Expected a file or text, found " + describe(target), node);
}

// split text into Line objects, numbered from 1
// a final line break does not make an extra empty line, and a \r at a line end is removed
function splitLines(text) {
  const parts = text.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  const lines = [];
  for (let index = 0; index < parts.length; index++) {
    lines.push(new Line(index + 1, parts[index].replace(/\r$/, "")));
  }
  return lines;
}

function isListOfLines(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => item instanceof Line);
}
function undoStepText(step) {
  const count = step.files.length === 1 ? "1 file" : step.files.length + " files";
  return step.number + ". " + step.time + "  " + count + ": " + step.files.join(", ");
}

function toText(value) {
  if (value === null || value === undefined) {
    return "null";
  }
  // a secret has no text; only print and an allowed fetch handle it
  if (value instanceof Secret) {
    throw new SecretUse(value, null);
  }
  // print shows a file as its path, so a list of many files stays short
  if (value instanceof FileRef) {
    return value.path;
  }
  if (value instanceof Line) {
    return value.text;
  }
  if (typeof value === "string") {
    return value;
  }
  // a list of lines is its text, one line each, with no numbers
  if (isListOfLines(value)) {
    return value.map((line) => line.text).join("\n");
  }
  // a process: "site: running"; a list of them, one line each
  if (value instanceof ProcessInfo) {
    return processLine(value);
  }
  if (Array.isArray(value) && value.length > 0 && value.every((item) => item instanceof ProcessInfo)) {
    return value.map(processLine).join("\n");
  }
  // the undo list: one line each, such as "1. 10:42  2 files: src/a.js, new.txt"
  if (value instanceof UndoStep) {
    return undoStepText(value);
  }
  if (Array.isArray(value) && value.length > 0 && value.every((item) => item instanceof UndoStep)) {
    return value.map(undoStepText).join("\n");
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

// the lines that contain the text, in a file, a list of files, or text
// lines from a file know their file, so print can show path:number
// what sorted and unique compare: a line by its text, a file by its path, other values by their text
function itemKey(item) {
  if (item instanceof Line) {
    return item.text;
  }
  if (item instanceof FileRef) {
    return item.path;
  }
  if (typeof item === "number") {
    return item;
  }
  return toText(item);
}

// numbers first, as numbers; then the rest by character code, so the order is the same everywhere
function compareItems(a, b) {
  const left = itemKey(a);
  const right = itemKey(b);
  const leftNumber = typeof left === "number";
  const rightNumber = typeof right === "number";
  if (leftNumber && rightNumber) {
    return left - right;
  }
  if (leftNumber !== rightNumber) {
    return leftNumber ? -1 : 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

// a job for the pattern worker; a job that runs too long is a script error
async function patternJob(job, state, node) {
  try {
    return await state.execution.patterns.run(job);
  } catch (err) {
    if (err.timedOut) {
      throw new ScriptError("The pattern ran for more than " + PATTERN_TIME_LIMIT / 1000 + " seconds, so it was stopped. A pattern such as (a+)+ can run for a very long time. Make it simpler", node);
    }
    throw new ScriptError("The pattern failed: " + err.message, node);
  }
}

// the lines that contain the text, or that match the pattern
async function matchingLines(text, lines, state, node) {
  if (!(text instanceof Pattern)) {
    return lines.filter((line) => line.text.includes(text));
  }
  const answer = await patternJob({ kind: "lines", source: text.source, flags: text.flags, lines: lines.map((line) => line.text) }, state, node);
  return answer.indexes.map((index) => lines[index]);
}

async function findLines(text, wanted, state, node) {
  const target = flatFiles(wanted);
  if (typeof target === "string") {
    return await matchingLines(text, splitLines(target), state, node);
  }
  // a list of lines, such as "lines 5 to 9 of f" or an earlier find: the lines keep their numbers and files
  if (isListOfLines(target)) {
    return await matchingLines(text, target, state, node);
  }
  let files = null;
  if (target instanceof FileRef) {
    files = [target];
  } else if (Array.isArray(target) && target.every((item) => item instanceof FileRef)) {
    files = target;
  } else {
    throw new ScriptError("'find' needs a file, a list of files, lines, or text, found " + describe(target), node);
  }
  const found = [];
  for (const file of files) {
    for (const line of await matchingLines(text, splitLines(await readText(file, state, node)), state, node)) {
      line.file = file;
      found.push(line);
    }
  }
  return found;
}

// a value for an error message: text in quotes, and a long value cut short
function describe(value) {
  let text = toText(showSecrets(value));
  let more = "";
  if (text.length > DESCRIBE_LENGTH) {
    more = "... (" + text.length + " characters)";
    text = text.slice(0, DESCRIBE_LENGTH);
  }
  if (typeof value === "string") {
    return "'" + text + "'" + more;
  }
  return text + more;
}
