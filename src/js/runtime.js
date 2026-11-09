// Runtime: runs a parsed script
//
// Everything is async, so later commands (read, fetch, ask) can wait
// without changing how scripts are written.
//
// A runtime error stops the script. "on error" comes later.

import { parse } from "./parser.js";
import { helpIndex, helpFor } from "./help.js";
import { unsafeConfig, guardArgs, gitEnv, isSafeBranchName, isSafeCommitName } from "./git.js";
import fs from "node:fs/promises";
import nodePath from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_MAX_STEPS = 10_000;
const AGENTS_TALK = "AGENTS.talk";

// error messages show at most this much of a value
const DESCRIBE_LENGTH = 80;

// how many scripts the undo list keeps
const UNDO_LIMIT = 20;

// the steps a hook can watch, apart from tool names
const HOOK_STEPS = ["read", "write", "append", "replace", "put", "remove", "change", "undo", "run", "git"];

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

// a "before" hook rejected a step; "on error" can handle this
class Rejected extends ScriptError {}

// the step budget is used up; "on error" cannot handle this
class StepBudget extends ScriptError {}

// a file in the project; nothing is read until a property is used
class FileRef {
  constructor(absolute, root) {
    this.absolute = absolute;
    // the path relative to the project root, with / on every platform
    this.path = nodePath.relative(root, absolute).split(nodePath.sep).join("/");
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
 * @param {Function} [options.ask]                   asks the human: async ({ question, choices, signal }) => text or null
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
  const maxSteps = options.maxSteps || DEFAULT_MAX_STEPS;
  const root = nodePath.resolve(options.root || process.cwd());

  const agents = await loadAgentsTalk(root, tools);
  if (agents.errors.length > 0) {
    return finish(execution, "failed", agents.errors);
  }

  const toolNames = Object.keys(tools).concat(Object.keys(agents.definitions));
  const { script, errors } = parse(source, { tools: toolNames });
  if (errors.length > 0) {
    return finish(execution, "failed", errors);
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
    // true if AGENTS.talk has "allow git push": then push does not ask the human
    allowGitPush: agents.allowGitPush,
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
    // the .talk file of the tool or hook now running; null for the script
    file: null,
    // the scripts that undo can take back, oldest first; a host keeps it for a session
    undo: options.undo || [],
    // the host's way to ask the human: async ({ question, choices, signal }) => text or null
    ask: options.ask || null,
  };

  try {
    await runCommands(script.commands, state, tools, maxSteps);
  } catch (err) {
    recordUndo(state);
    if (err instanceof Cancelled) {
      return finish(execution, "cancelled", [errorFor(err)]);
    }
    if (err instanceof ScriptError) {
      return finish(execution, "failed", [errorFor(err)]);
    }
    throw err;
  }

  recordUndo(state);
  return finish(execution, "done", []);
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
    list.push({ name, params: [], description: "A tool from the host." });
  }
  return list;
}

// read and parse @/AGENTS.talk and the files it imports
// gives { definitions: name to tool node, allowedEnv, errors }
async function loadAgentsTalk(root, hostTools) {
  const result = { definitions: Object.create(null), allowedEnv: [], allowedChanges: [], allowGitPush: false, hooks: [], errors: [] };
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
    for (const definition of file.firstPass.script.definitions) {
      if (definition.type === "tool") {
        names.push(definition.name);
      }
    }
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
      if (definition.type === "allowEnv") {
        if (file.name === AGENTS_TALK) {
          result.allowedEnv.push(...definition.names);
        } else {
          result.errors.push({ message: "'allow env' is only allowed in " + AGENTS_TALK, ...where });
        }
        continue;
      }
      if (definition.type === "allowGitPush") {
        if (file.name === AGENTS_TALK) {
          result.allowGitPush = true;
        } else {
          result.errors.push({ message: "'allow git push' is only allowed in " + AGENTS_TALK, ...where });
        }
        continue;
      }
      if (definition.type === "allowChanges") {
        if (file.name !== AGENTS_TALK) {
          result.errors.push({ message: "'allow changes to' is only allowed in " + AGENTS_TALK, ...where });
          continue;
        }
        for (const shown of definition.paths) {
          // @/ and ./ both start from the root, where AGENTS.talk is
          const rest = shown.startsWith("@/") ? shown.slice(2) : shown;
          const absolute = nodePath.resolve(root, rest);
          if (!isInside(absolute, root) || absolute === root) {
            result.errors.push({ message: "Cannot allow changes to " + shown + ": it must be inside the project root", ...where });
            continue;
          }
          result.allowedChanges.push(nodePath.relative(root, absolute).split(nodePath.sep).join("/"));
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

function finish(execution, status, errors) {
  execution.status = status;
  execution.errors = errors;
  return { status, output: execution.output, errors, warnings: execution.warnings, steps: execution.steps, changes: execution.changes };
}

// ----- commands -----

// every command is one step, and so is every pass of a loop,
// so a script that does not end stops at the budget
// this is also where the host sees progress, and where cancel takes effect
function takeStep(node, state, maxSteps) {
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
async function runCommands(commands, state, tools, maxSteps) {
  for (const command of commands) {
    if (command.type === "onError") {
      continue;
    }
    takeStep(command, state, maxSteps);
    let signal;
    try {
      signal = await runCommand(command, state, tools, maxSteps);
    } catch (err) {
      if (!canHandle(err, state)) {
        throw err;
      }
      // continue: go on with the command after the one that failed
      if (await runHandler(err, state, tools, maxSteps) === "continue") {
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
async function runHandler(err, state, tools, maxSteps) {
  const error = Object.create(null);
  error.message = err.message;
  error.line = err.line;
  error.column = err.column;
  if (err.file) {
    error.file = err.file;
  }
  setOwn(state.variables, "error", error);
  state.handling = true;
  try {
    const signal = await runCommands(state.handler.body, state, tools, maxSteps);
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
async function runLoopBody(node, state, tools, maxSteps) {
  takeStep(node, state, maxSteps);
  const signal = await runCommands(node.body, state, tools, maxSteps);
  return signal === "break";
}

async function runCommand(command, state, tools, maxSteps) {
  if (command.type === "print") {
    const value = await evaluate(command.value, state);
    // print shows a list of lines with their numbers, as an editor does
    if (isListOfLines(value)) {
      state.execution.output.push(value.map((line) => lineLabel(line) + line.text).join("\n"));
    } else {
      state.execution.output.push(toText(value));
    }
    return;
  }

  if (command.type === "if") {
    const condition = await evaluate(command.condition, state);
    if (isTrue(condition)) {
      // pass break and continue up to the loop
      return await runCommands(command.body, state, tools, maxSteps);
    }
    return await runCommands(command.elseBody, state, tools, maxSteps);
  }

  if (command.type === "break" || command.type === "continue" || command.type === "stop") {
    return command.type;
  }

  if (command.type === "for") {
    const list = await evaluate(command.list, state);
    const items = loopItems(list, command);
    for (let index = 0; index < items.length; index++) {
      setOwn(scopeFor(command.name, state), command.name, items[index]);
      if (command.index !== null) {
        setOwn(scopeFor(command.index, state), command.index, index);
      }
      if (await runLoopBody(command, state, tools, maxSteps)) {
        break;
      }
    }
    return null;
  }

  if (command.type === "repeat") {
    let count = null;
    if (command.kind === "times") {
      count = toNumber(await evaluate(command.value, state), command);
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
      if (await runLoopBody(command, state, tools, maxSteps)) {
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

  if (command.type === "ask") {
    state.result = await askHuman(command, state);
    return null;
  }
  if (command.type === "undo") {
    state.result = await runUndo(command, state);
    return null;
  }
  if (command.type === "git") {
    await runGit(command, state);
    return null;
  }
  if (command.type === "find") {
    const text = toText(await asText(await evaluate(command.text, state), state, command));
    if (text === "") {
      throw new ScriptError("Cannot find empty text", command);
    }
    const target = await evaluate(command.target, state);
    state.result = await findLines(text, target, state, command);
    return null;
  }

  if (command.type === "write" || command.type === "append") {
    const value = await evaluate(command.value, state);
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
      newText = toText(await asText(await evaluate(command.text, state), state, command));
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
    const newText = toText(await asText(await evaluate(command.text, state), state, command));
    // an empty range: before line n puts the text just before it, after line n just after it
    const at = command.where === "before" ? number : number + 1;
    const step = changeStep("put", file, { line: number, where: command.where, text: newText });
    await changeHooks("before", step, state, command);
    state.result = await editLines(file, at, at - 1, newText, state, command, number);
    await changeHooks("after", step, state, command);
    return null;
  }

  if (command.type === "replace") {
    const old = toText(await asText(await evaluate(command.old, state), state, command));
    const replacement = toText(await asText(await evaluate(command.replacement, state), state, command));
    if (old === "") {
      throw new ScriptError("Cannot replace empty text", command);
    }
    const target = await evaluate(command.target, state);
    if (target instanceof FileRef) {
      const step = changeStep("replace", target, { old, new: replacement });
      await changeHooks("before", step, state, command);
      const before = await readText(target, state, command);
      const { text, replacements } = replaceAll(before, old, replacement);
      if (replacements.length > 0) {
        await writeText(target, text, false, state, command);
      }
      state.result = replacements;
      warnIfNoMatch(replacements, old, target.path, state, command);
      await changeHooks("after", step, state, command);
      return null;
    }
    const isAssignable = command.target.type === "variable" || command.target.type === "property" || command.target.type === "index";
    if (typeof target === "string" && isAssignable) {
      const { text, replacements } = replaceAll(target, old, replacement);
      await assign(command.target, text, state);
      state.result = replacements;
      warnIfNoMatch(replacements, old, "the variable", state, command);
      return null;
    }
    throw new ScriptError("Expected a file, or a variable with text, found " + describe(target), command);
  }

  if (command.type === "run") {
    state.result = await runProgram(command, state);
    return null;
  }

  if (command.type === "reject") {
    throw new Rejected(toText(await evaluate(command.message, state)), command);
  }

  if (command.type === "help") {
    const list = toolList(state, tools);
    let text;
    if (command.word === null) {
      text = helpIndex(list);
    } else {
      text = helpFor(command.word, list);
      if (text === null) {
        throw new ScriptError("No help for '" + command.word + "'. Use help to list everything", command);
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

  if (command.type === "increment" || command.type === "decrement") {
    const current = await evaluate(command.target, state);
    let amount = toNumber(await evaluate(command.amount, state), command);
    if (command.type === "decrement") {
      amount = -amount;
    }
    // a variable that is not set yet starts at 0
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

    const step = Object.create(null);
    step.args = args;
    step.named = named;
    await runHooks("before", [command.name], step, state, command);

    const definition = state.definitions[command.name];
    if (definition !== undefined) {
      // "within" on the call limits every run inside the tool; the shorter limit wins
      const savedLimit = state.timeLimit;
      if (command.within !== null) {
        state.timeLimit = shorter(state.timeLimit, await durationMs(command.within, state));
      }
      try {
        state.result = await callTool(definition, args, named, command, state, tools, maxSteps);
      } finally {
        state.timeLimit = savedLimit;
      }
      await runHooks("after", [command.name], step, state, command);
      return null;
    }

    const signal = state.execution.signal;
    try {
      state.result = await tools[command.name]({ signal, args, named });
    } catch (err) {
      if (signal.aborted) {
        throw new Cancelled("Cancelled", command);
      }
      throw new ScriptError("Tool '" + command.name + "' failed: " + err.message, command);
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
  if (type === "lines") {
    const target = await evaluate(node.target, state);
    let all;
    if (target instanceof FileRef) {
      all = splitLines(await readText(target, state, node));
    } else if (typeof target === "string") {
      all = splitLines(target);
    } else {
      throw new ScriptError("Expected a file or text, found " + describe(target), node);
    }
    const from = toNumber(await evaluate(node.from, state), node);
    const to = toNumber(await evaluate(node.to, state), node);
    // line numbers start at 1, both ends are included, and a range past the end stops at the last line
    return all.slice(Math.max(from, 1) - 1, Math.max(to, 0));
  }
if (type === "read") {
    return await readText(await evaluate(node.file, state), state, node);
  }
  if (type === "null") {
    return null;
  }
  if (type === "template") {
    let text = "";
    for (const part of node.parts) {
      if (typeof part === "string") {
        text += part;
      } else {
        text += toText(await asText(await evaluate(part, state), state, part));
      }
    }
    return text;
  }
  if (type === "result") {
    return state.result;
  }
  if (type === "variable") {
    const scope = scopeFor(node.name, state);
    if (Object.hasOwn(scope, node.name)) {
      return scope[node.name];
    }
    return null;
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
  if (type === "property") {
    const object = await evaluate(node.object, state);
    if (object instanceof FileRef) {
      return await fileProperty(object, node.name, state, node);
    }
    // text has lines, as a file does
    if (typeof object === "string" && node.name === "lines") {
      return splitLines(object);
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
    return evaluateUnary(node, await evaluate(node.value, state));
  }
  if (type === "check") {
    let value = await evaluate(node.value, state);
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
    return convert(node, await evaluate(node.value, state));
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
    // text operators use the text of a file or a line
    if (TEXT_OPERATORS.includes(node.operator)) {
      left = await asText(left, state, node);
      right = await asText(right, state, node);
    }
    return evaluateBinary(node, left, right);
  }

  throw new ScriptError("Unknown expression type '" + type + "'", node);
}

// run a tool from AGENTS.talk, with its own local variables
// gives back the tool's result at the end of the tool
async function callTool(definition, args, named, command, state, tools, maxSteps) {
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
  try {
    await runCommands(definition.body, state, tools, maxSteps);
    return state.result;
  } catch (err) {
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
  const value = await evaluate(command.program, state);
  let program;
  let args = [];
  if (command.args === null) {
    // run 'mvn test': split on spaces
    const parts = toText(value).split(/\s+/).filter((part) => part !== "");
    program = parts[0];
    args = parts.slice(1);
  } else {
    // run 'mvn' with 'test', name: each argument as it is
    program = toText(value);
    for (const arg of command.args) {
      args.push(toText(await asText(await evaluate(arg, state), state, arg)));
    }
  }
  if (!program) {
    throw new ScriptError("Nothing to run", command);
  }

  const step = Object.create(null);
  step.program = program;
  step.args = args;
  await runHooks("before", ["run"], step, state, command);

  // only the environment variables that AGENTS.talk allows
  const env = {};
  for (const name of state.allowedEnv) {
    if (process.env[name] !== undefined) {
      env[name] = process.env[name];
    }
  }

  let limit = state.timeLimit;
  if (command.within !== null) {
    limit = shorter(limit, await durationMs(command.within, state));
  }

  const result = await spawnProgram(program, args, state.cwd, env, limit, state, command);

  // after hooks see the result
  state.result = result;
  await runHooks("after", ["run"], step, state, command);
  return result;
}

// git <operation>: a hardened git; see src/md/features/git.md and src/js/git.js
// the result is git's output as text; a failed git call is a script error
async function runGit(command, state) {
  const step = Object.create(null);
  step.operation = command.operation;
  const args = await gitArgs(command, state, step);
  step.args = args;
  await runHooks("before", ["git"], step, state, command);

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

  // push asks the human first, unless AGENTS.talk allows it
  if (command.operation === "push" && !state.allowGitPush) {
    const current = await spawnProgram("git", [...guardArgs(), "branch", "--show-current"], state.root, env, state.timeLimit, state, command);
    const branch = current.output.trim();
    const answer = await askState(state, "Push branch '" + branch + "' to origin?", ["yes", "no"], null);
    if (answer !== "yes") {
      throw new ScriptError(
        "The human did not approve the push" + (state.ask === null ? ": there is no way to ask them here" : "") + ". Nothing was pushed.\n" +
        "To push without asking, a human can add this line to AGENTS.talk:\n" +
        "  allow git push",
        command,
      );
    }
  }

  // commit adds the named files first, so new files can be committed too;
  // the commit then has only those files, even if other files are staged
  if (command.operation === "commit") {
    const add = await spawnProgram("git", [...guardArgs(), "add", "--", ...step.files], state.root, env, state.timeLimit, state, command);
    if (add.code !== 0) {
      throw new ScriptError("git add failed: " + add.output.trim(), command);
    }
  }

  const forPush = command.operation === "push";
  const result = await spawnProgram("git", [...guardArgs(forPush), ...args], state.root, gitEnv(process.env, forPush), state.timeLimit, state, command);
  if (result.code !== 0) {
    throw new ScriptError("git " + command.operation + " failed: " + result.output.trim(), command);
  }
  state.result = result.output;
  await runHooks("after", ["git"], step, state, command);
  return result.output;
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
    const name = toText(await evaluate(command.value, state));
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
    const name = toText(await evaluate(command.value, state));
    if (!isSafeBranchName(name)) {
      throw new ScriptError("Not a safe branch name: " + describe(name) + ". Use letters, digits, -, _, / and .", command.value);
    }
    step.branch = name;
    return ["branch", "--delete", name];
  }
  // the current branch, to a branch with the same name on origin; never force
  if (op === "push") {
    return ["push", "--no-verify", "origin", "HEAD"];
  }
  // fast-forward only: a merge never makes a commit, so it needs no message and cannot conflict
  if (op === "merge") {
    const name = toText(await evaluate(command.value, state));
    if (!isSafeBranchName(name)) {
      throw new ScriptError("Not a safe branch name: " + describe(name) + ". Use letters, digits, -, _, / and .", command.value);
    }
    step.branch = name;
    return ["merge", "--ff-only", name];
  }
  if (op === "commit") {
    const value = await evaluate(command.value, state);
    const files = Array.isArray(value) ? value : [value];
    if (files.length === 0) {
      throw new ScriptError("git commit found no files to commit", command.value);
    }
    const paths = [];
    for (const file of files) {
      if (!(file instanceof FileRef)) {
        throw new ScriptError("git commit needs a file or a list of files, found " + describe(file), command.value);
      }
      // a hidden file, such as .env, often holds secrets
      const hidden = await isHidden(file, state);
      if (hidden !== null) {
        throw new ScriptError(
          "A script cannot commit hidden files or folders (a name that starts with .): " + file.path + "\n" +
          "To allow this, a human can add this line to AGENTS.talk:\n" +
          "  " + allowLineFor(hidden),
          command.value,
        );
      }
      paths.push(file.path);
    }
    const message = toText(await evaluate(command.message, state));
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
    return ["show", "--no-ext-diff", "--no-textconv", "--no-show-signature", name, "--"];
  }
  if (op === "diff") {
    const args = ["diff", "--no-ext-diff", "--no-textconv", "--"];
    if (command.value !== null) {
      const value = await evaluate(command.value, state);
      const files = Array.isArray(value) ? value : [value];
      // an empty list would give the diff of everything, which is a surprise
      if (files.length === 0) {
        throw new ScriptError("git diff found no files to show", command.value);
      }
      for (const file of files) {
        if (!(file instanceof FileRef)) {
          throw new ScriptError("git diff needs a file or a list of files, found " + describe(file), command.value);
        }
        args.push(file.path);
      }
    }
    return args;
  }
  throw new ScriptError("Unknown git operation: " + op, command);
}

// start a program with no shell, and wait for it; used by run and git
// gives { code, output }: the exit code, and stdout and stderr together, in the order they came
function spawnProgram(program, args, cwd, env, limit, state, node) {
  const signal = state.execution.signal;
  return new Promise((resolve, reject) => {
    let output = "";
    let timedOut = false;
    let timer = null;

    const child = spawn(program, args, { cwd, env, signal, shell: false });

    if (limit !== null) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, limit);
    }

    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });

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
      if (signal.aborted) {
        reject(new Cancelled("Cancelled", node));
      } else if (timedOut) {
        reject(new ScriptError("'" + program + "' did not finish within " + limit + "ms", node));
      } else {
        resolve({ code: code === null ? -1 : code, output });
      }
    });
  });
}

// ----- ask -----

// ask the human; only the host can reach them, through options.ask
// with no host, no answer in time, or an answer that is not a choice, the result is null
async function askHuman(command, state) {
  const question = toText(await asText(await evaluate(command.question, state), state, command.question));
  const choices = [];
  for (const choice of command.choices) {
    choices.push(toText(await asText(await evaluate(choice, state), state, choice)));
  }
  let limit = state.timeLimit;
  if (command.within !== null) {
    limit = shorter(limit, await durationMs(command.within, state));
  }
  return await askState(state, question, choices, limit);
}

// ask through the host, with a time limit in ms or null; used by ask and git push
async function askState(state, question, choices, limit) {
  if (state.ask === null) {
    return null;
  }
  let timer = null;
  let answer = null;
  try {
    const asking = state.ask({ question, choices, signal: state.execution.signal });
    if (limit === null) {
      answer = await asking;
    } else {
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), limit);
      });
      answer = await Promise.race([asking, timeout]);
    }
  } catch (err) {
    // a host that fails to ask gives no answer
    answer = null;
  } finally {
    clearTimeout(timer);
  }

  if (typeof answer !== "string") {
    return null;
  }
  if (choices.length > 0 && !choices.includes(answer)) {
    return null;
  }
  return answer;
}

// ----- undo -----

// at the end of a script, its file changes go on the undo list, even if it failed part way
// one item for each file: the text before the script, and after it
function recordUndo(state) {
  const byPath = new Map();
  for (const change of state.execution.changes) {
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
  // the items to take back, newest first: { path, before, after }
  let items = [];
  let entries = [];
  if (command.file !== null) {
    const file = await evaluate(command.file, state);
    if (!(file instanceof FileRef)) {
      throw new ScriptError("Expected a file, found " + describe(file), command.file);
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

  const restored = [];
  for (const [path, text] of final) {
    await restoreFile(path, text, state, command);
    restored.push(path);
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

// the text of a project file now, or null if it does not exist
async function currentText(path, state) {
  try {
    return await fs.readFile(nodePath.resolve(state.root, path), "utf8");
  } catch (err) {
    return null;
  }
}

// put a file back to its old text; null removes a file that the script made
// the same checks as a write, and the "undo" and "change" hooks
async function restoreFile(path, text, state, node) {
  const file = new FileRef(nodePath.resolve(state.root, path), state.root);
  checkInsideRoot(file.absolute, state, node, path);
  if (await isProtected(file, state, node)) {
    throw new ScriptError("A script cannot change .talk files or the @/talk folder: " + file.path, node);
  }
  if ((await isHidden(file, state)) !== null) {
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
async function changeHooks(when, step, state, node) {
  await runHooks(when, [step.kind, "change"], step, state, node);
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
  const locals = Object.create(null);
  setOwn(locals, hook.name, step);
  state.variables = locals;
  state.handler = findHandler(hook.body);
  state.handling = false;
  state.inHook = true;
  const savedFile = state.file;
  state.file = hook.file;
  try {
    await runCommands(hook.body, state, state.tools, state.maxSteps);
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
  }
}

// what a "for" loop goes over: a list; null gives no passes
// later: the lines of a file
function loopItems(value, node) {
  if (value === null || value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  throw new ScriptError("Cannot loop over " + describe(value) + ", expected a list", node);
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
    setOwn(scopeFor(target.name, state), target.name, value);
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
  // some fields cannot change, for example the length of a list
  try {
    setOwn(object, name, value);
  } catch (err) {
    throw new ScriptError("Cannot set '" + name + "'", target);
  }
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
    if (typeof left === "string" || typeof right === "string") {
      return toText(left) + toText(right);
    }
    return toNumber(left, node) + toNumber(right, node);
  }
  if (op === "-") {
    return toNumber(left, node) - toNumber(right, node);
  }
  if (op === "*") {
    return toNumber(left, node) * toNumber(right, node);
  }
  if (op === "/") {
    const divisor = toNumber(right, node);
    if (divisor === 0) {
      throw new ScriptError("Division by zero", node);
    }
    return toNumber(left, node) / divisor;
  }
  if (op === "mod") {
    const divisor = toNumber(right, node);
    if (divisor === 0) {
      throw new ScriptError("Division by zero", node);
    }
    return toNumber(left, node) % divisor;
  }

  if (op === "is") {
    return left === right;
  }
  if (op === "is not") {
    return left !== right;
  }
  if (op === "is less than") {
    return toNumber(left, node) < toNumber(right, node);
  }
  if (op === "is greater than") {
    return toNumber(left, node) > toNumber(right, node);
  }
  if (op === "is less than or equal to") {
    return toNumber(left, node) <= toNumber(right, node);
  }
  if (op === "is greater than or equal to") {
    return toNumber(left, node) >= toNumber(right, node);
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
  if (op === "starts with") {
    return toText(left).startsWith(toText(right));
  }
  if (op === "ends with") {
    return toText(left).endsWith(toText(right));
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
const TEXT_OPERATORS = ["contains", "does not contain", "starts with", "ends with", "is in", "is not in", "+"];

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
  return new FileRef(absolute, state.root);
}

// a glob skips these folders, unless the pattern names them: ./node_modules/x/*.js still works
const SKIPPED_FOLDERS = ["node_modules", ".git"];

async function globFiles(base, pattern, state, node) {
  const parts = pattern.split("/");
  const skipped = [];
  for (const name of SKIPPED_FOLDERS) {
    if (!parts.includes(name)) {
      skipped.push(name);
    }
  }
  // fs.glob calls exclude for each file and folder, so a skipped folder is not walked
  const exclude = (path) => skipped.includes(nodePath.basename(path));
  const files = [];
  for await (const match of fs.glob(pattern, { cwd: base, exclude })) {
    const absolute = nodePath.resolve(base, match);
    checkInsideRoot(absolute, state, node, match);
    const stats = await fs.stat(absolute);
    if (stats.isFile()) {
      files.push(new FileRef(absolute, state.root));
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
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
    throw new ScriptError("Cannot open " + file.path + ": " + err.message, node);
  }
  const realRoot = await fs.realpath(state.root);
  if (!isInside(real, realRoot)) {
    throw new ScriptError("Path is outside the project root: " + file.path, node);
  }
  return real;
}

async function fileExists(file, state, node) {
  return (await realPath(file, state, node)) !== null;
}

async function readText(file, state, node) {
  if (!(file instanceof FileRef)) {
    throw new ScriptError("Expected a file, found " + describe(file), node);
  }
  const real = await realPath(file, state, node);
  if (real === null) {
    throw new ScriptError("File not found: " + file.path, node);
  }
  const stats = await fs.stat(real);
  if (!stats.isFile()) {
    throw new ScriptError("Not a file: " + file.path, node);
  }
  const step = Object.create(null);
  step.path = file.path;
  await runHooks("before", ["read"], step, state, node);
  const text = await fs.readFile(real, "utf8");
  // remember what the script saw, for the stale-write check
  state.seen.set(real, text);
  step.text = text;
  await runHooks("after", ["read"], step, state, node);
  return text;
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

  const parts = text.split("\n");
  const finalBreak = parts.length > 0 && parts[parts.length - 1] === "";
  if (finalBreak) {
    parts.pop();
  }
  const count = parts.length;
  if (putLine !== undefined) {
    if (!Number.isInteger(putLine) || putLine < 1 || putLine > count) {
      throw new ScriptError("Line " + putLine + " is not in " + file.path + ", which has " + count + " lines", node);
    }
  } else if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > count || from > to) {
    throw new ScriptError("Lines " + from + " to " + to + " are not in " + file.path + ", which has " + count + " lines", node);
  }

  let newParts = [];
  if (newText !== null) {
    newParts = newText.split("\n");
    // a final line break in the new text does not make an extra empty line
    // but empty text is one empty line; "remove lines" takes lines away
    if (newParts.length > 1 && newParts[newParts.length - 1] === "") {
      newParts.pop();
    }
  }
  const old = parts.splice(from - 1, to - from + 1, ...newParts);
  let result = parts.join("\n");
  if (finalBreak && parts.length > 0) {
    result += "\n";
  }
  await writeText(file, result, false, state, node);

  const oldLines = [];
  for (let index = 0; index < old.length; index++) {
    oldLines.push(new Line(from + index, old[index]));
  }
  return oldLines;
}

async function writeText(file, text, append, state, node) {
  if (Array.isArray(file)) {
    throw new ScriptError("Expected one file, found a list of " + file.length + ". Use a for loop", node);
  }
  if (!(file instanceof FileRef)) {
    throw new ScriptError("Expected a file, found " + describe(file), node);
  }
  if (await isProtected(file, state, node)) {
    throw new ScriptError("A script cannot change .talk files or the @/talk folder: " + file.path, node);
  }
  const hidden = await isHidden(file, state);
  if (hidden !== null) {
    throw new ScriptError(
      "A script cannot change hidden files or folders (a name that starts with .): " + file.path + "\n" +
      "To allow this, a human can add this line to AGENTS.talk:\n" +
      "  " + allowLineFor(hidden),
      node,
    );
  }

  let real = await realPath(file, state, node);
  let before = null;
  if (real !== null) {
    const stats = await fs.stat(real);
    if (!stats.isFile()) {
      throw new ScriptError("Not a file: " + file.path, node);
    }
    before = await fs.readFile(real, "utf8");
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
  }
  await fs.writeFile(real, after, "utf8");
  state.seen.set(await fs.realpath(real), after);
  state.execution.changes.push({ path: file.path, before, after });
}

// is this file AGENTS.talk, by name (any case) or by being the same file on disk (a link to it)?
// a protected path, relative to the root: any .talk file, or anything in the talk folder
// letter case does not matter, because some file systems ignore it
function isProtectedPath(relative) {
  const lower = relative.toLowerCase();
  return lower.endsWith(".talk") || lower === "talk" || lower.startsWith("talk/");
}

// scripts cannot change .talk files or the @/talk folder, so an agent cannot change its own tools
// the check uses the path as written, the path after symlinks, and for AGENTS.talk
// also the file on disk, so a hard link to it is refused too
async function isProtected(file, state, node) {
  if (isProtectedPath(file.path)) {
    return true;
  }
  const real = await realPath(file, state, node);
  if (real === null) {
    return false;
  }
  const realRoot = await fs.realpath(state.root);
  const realRelative = nodePath.relative(realRoot, real).split(nodePath.sep).join("/");
  if (isProtectedPath(realRelative)) {
    return true;
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
async function isHidden(file, state) {
  if (isHiddenPath(file.path) && !isAllowedChange(file.path, state)) {
    return file.path;
  }
  let existing = file.absolute;
  while (true) {
    try {
      await fs.stat(existing);
      break;
    } catch (err) {
      existing = nodePath.dirname(existing);
    }
  }
  const real = nodePath.join(await fs.realpath(existing), nodePath.relative(existing, file.absolute));
  const realRoot = await fs.realpath(state.root);
  const relative = nodePath.relative(realRoot, real).split(nodePath.sep).join("/");
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
  const parent = nodePath.dirname(file.absolute);
  let existing = parent;
  while (true) {
    try {
      await fs.stat(existing);
      break;
    } catch (err) {
      existing = nodePath.dirname(existing);
    }
  }
  const realExisting = await fs.realpath(existing);
  const realRoot = await fs.realpath(state.root);
  if (!isInside(realExisting, realRoot)) {
    throw new ScriptError("Path is outside the project root: " + file.path, node);
  }
  await fs.mkdir(parent, { recursive: true });
}

// a replace that finds nothing is often a mistake, such as a wrong line break or indent
// it is a warning, not an error, so "if the result is empty" still works
function warnIfNoMatch(replacements, old, where, state, node) {
  if (replacements.length > 0) {
    return;
  }
  const warning = { message: "No match in " + where + " for " + describe(old), line: node.line, column: node.column };
  if (state.file) {
    warning.file = state.file;
  }
  state.execution.warnings.push(warning);
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
    return container.includes(toText(item));
  }
  if (Array.isArray(container)) {
    return container.includes(item);
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

// false, null, 0, "" and empty lists are false, everything else is true
function isTrue(value) {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return Boolean(value);
}

function toNumber(value, node) {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "" && !isNaN(Number(value))) {
    return Number(value);
  }
  throw new ScriptError("Expected a number, found " + describe(value), node);
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
async function findLines(text, target, state, node) {
  if (typeof target === "string") {
    const found = [];
    for (const line of splitLines(target)) {
      if (line.text.includes(text)) {
        found.push(line);
      }
    }
    return found;
  }
  let files = null;
  if (target instanceof FileRef) {
    files = [target];
  } else if (Array.isArray(target) && target.every((item) => item instanceof FileRef)) {
    files = target;
  } else {
    throw new ScriptError("'find' needs a file, a list of files, or text, found " + describe(target), node);
  }
  const found = [];
  for (const file of files) {
    for (const line of splitLines(await readText(file, state, node))) {
      if (line.text.includes(text)) {
        line.file = file;
        found.push(line);
      }
    }
  }
  return found;
}

// a value for an error message: text in quotes, and a long value cut short
function describe(value) {
  let text = toText(value);
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
