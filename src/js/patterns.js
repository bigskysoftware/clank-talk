import { Worker } from "node:worker_threads";

/**
 * Patterns: JavaScript regexps with the u flag, for find, replace and matches.
 * A pattern such as (a+)+$ can run for minutes, and a regexp cannot be stopped while it runs.
 * So the work runs in a worker thread, and a job that runs too long stops the worker.
 * See src/md/features/language.md.
 */

// the time limit for one pattern job, in ms
export const PATTERN_TIME_LIMIT = 2000;

/** A pattern value, made by: pattern /<regexp>/flags or pattern '<regexp>' */
export class Pattern {
  // flags: "", or some of i, m and s (from pattern /regex/flags); u is always on
  constructor(source, flags = "") {
    // compile it here, to give a bad pattern as an error at once; compiling cannot run away
    new RegExp(source, "u" + flags);
    this.source = source;
    this.flags = flags;
  }
}

// the worker: each message is one job; the answer has the same id
const WORKER_CODE = String.raw`
const { parentPort } = require("node:worker_threads");

// the new text for one match: $1, $<name>, $& and $$, as in JavaScript
function expand(replacement, match) {
  return replacement.replace(/\$(\$|&|<([^>]*)>|(\d\d?))/gu, (all, what, name, number) => {
    if (what === "$") {
      return "$";
    }
    if (what === "&") {
      return match[0];
    }
    if (name !== undefined) {
      if (match.groups === undefined || !(name in match.groups)) {
        return all;
      }
      return match.groups[name] ?? "";
    }
    const index = Number(number);
    if (index < 1 || index >= match.length) {
      return all;
    }
    return match[index] ?? "";
  });
}

parentPort.on("message", (job) => {
  const answer = { id: job.id };
  if (job.kind === "lines") {
    const regexp = new RegExp(job.source, "u" + (job.flags || ""));
    answer.indexes = [];
    job.lines.forEach((line, index) => {
      if (regexp.test(line)) {
        answer.indexes.push(index);
      }
    });
  } else if (job.kind === "test") {
    answer.matches = new RegExp(job.source, "u" + (job.flags || "")).test(job.text);
  } else if (job.kind === "replace") {
    const pieces = [];
    answer.replacements = [];
    let last = 0;
    for (const match of job.text.matchAll(new RegExp(job.source, "gu" + (job.flags || "")))) {
      const piece = expand(job.replacement, match);
      pieces.push(job.text.slice(last, match.index), piece);
      answer.replacements.push({ index: match.index, old: match[0], new: piece });
      last = match.index + match[0].length;
    }
    pieces.push(job.text.slice(last));
    answer.text = pieces.join("");
  }
  parentPort.postMessage(answer);
});
`;

/**
 * The pattern worker of one run. Made when the first pattern needs it; stop() ends it.
 */
export class PatternWorker {
  constructor() {
    this.worker = null;
    this.nextId = 1;
    this.waiting = new Map();
  }

  /**
   * Run one job in the worker. Gives the answer, or throws an Error with timedOut set.
   */
  run(job) {
    if (this.worker === null) {
      this.start();
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // the job runs away: stop the worker, and start a new one for the next job
        this.waiting.delete(id);
        this.stop();
        const err = new Error("timed out");
        err.timedOut = true;
        reject(err);
      }, PATTERN_TIME_LIMIT);
      this.waiting.set(id, { resolve, reject, timer });
      this.worker.postMessage({ ...job, id });
    });
  }

  start() {
    this.worker = new Worker(WORKER_CODE, { eval: true });
    // the worker never keeps the process alive
    this.worker.unref();
    this.worker.on("message", (answer) => {
      const waiting = this.waiting.get(answer.id);
      if (waiting !== undefined) {
        clearTimeout(waiting.timer);
        this.waiting.delete(answer.id);
        waiting.resolve(answer);
      }
    });
    this.worker.on("error", (err) => {
      for (const waiting of this.waiting.values()) {
        clearTimeout(waiting.timer);
        waiting.reject(err);
      }
      this.waiting.clear();
      this.worker = null;
    });
  }

  stop() {
    if (this.worker !== null) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}
