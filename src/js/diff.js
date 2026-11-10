// A short diff of the files a script changed, for the agent: the changed lines with their numbers,
// and 1 line of context. Thus the agent sees a wrong edit at once, such as a wrong escape.
// See src/md/infrastructure/host.md.

const CONTEXT = 1;
const MAX_FILE_LINES = 20;
const MAX_ALL_LINES = 60;
const MAX_LINE_WIDTH = 160;
// above this many changed lines, the middle part is shown as all removed, then all added
const MAX_EDITS = 1000;

/**
 * The "changed files" text: one entry for each file, the first text before against the last text after.
 * @param {{ path: string, before: string|null, after: string|null }[]} changes  in the order they happened
 * @returns {string}
 */
export function changedFiles(changes) {
  const files = new Map();
  for (const change of changes) {
    const file = files.get(change.path);
    if (file === undefined) {
      files.set(change.path, { before: change.before, after: change.after });
    } else {
      file.after = change.after;
    }
  }
  const lines = [];
  let budget = MAX_ALL_LINES;
  for (const [path, file] of files) {
    if (file.before === null && file.after !== null) {
      const count = splitLines(file.after).length;
      lines.push(path + "  (new file, " + count + (count === 1 ? " line)" : " lines)"));
    } else if (file.after === null) {
      lines.push(path + "  (removed)");
    } else if (file.before === file.after) {
      lines.push(path + "  (no change)");
    } else {
      lines.push(path);
      budget = diffLines(file.before, file.after, budget, lines);
    }
  }
  return lines.join("\n");
}

// add the changed lines of one file to "out"; gives back what is left of the budget for all files
function diffLines(before, after, budget, out) {
  const entries = lineEntries(splitLines(before), splitLines(after));
  const width = String(entries.length === 0 ? 1 : Math.max(...entries.map((e) => e.number))).length;
  // show a context line only if it is next to a change
  const near = (index) => {
    for (let d = -CONTEXT; d <= CONTEXT; d++) {
      const e = entries[index + d];
      if (e !== undefined && e.mark !== " ") {
        return true;
      }
    }
    return false;
  };
  let shown = 0;
  let hidden = 0;
  let last = -1;
  for (let index = 0; index < entries.length; index++) {
    const e = entries[index];
    const full = shown >= MAX_FILE_LINES || budget <= 0;
    if (e.mark === " " && (!near(index) || full)) {
      continue;
    }
    if (e.mark !== " " && full) {
      hidden++;
      continue;
    }
    if (e.mark !== " ") {
      shown++;
      budget--;
    }
    // "..." for unchanged lines that are not shown
    if (last !== -1 && index > last + 1) {
      out.push("  ...");
    }
    out.push(e.mark + " " + String(e.number).padStart(width) + "  " + cut(e.text));
    last = index;
  }
  if (hidden > 0) {
    out.push("  ... " + hidden + " more changed lines");
  }
  return budget;
}

// every line, marked " " (the same), "-" (removed) or "+" (added), with its number:
// the old number for a removed line, the new number for the others
function lineEntries(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const entries = [];
  for (let i = 0; i < start; i++) {
    entries.push({ mark: " ", number: i + 1, text: a[i] });
  }
  for (const op of middle(a.slice(start, endA), b.slice(start, endB))) {
    if (op.mark === "-") {
      entries.push({ mark: "-", number: start + op.a + 1, text: op.text });
    } else {
      entries.push({ mark: op.mark, number: start + op.b + 1, text: op.text });
    }
  }
  for (let i = endA; i < a.length; i++) {
    entries.push({ mark: " ", number: endB + (i - endA) + 1, text: a[i] });
  }
  return entries;
}

// the changed middle part, with the Myers diff: the work grows with the number of changed lines, not the file size
// trace[d] keeps, for each diagonal k from -d-1 to d+1, how far along a the best path got before round d
function middle(a, b) {
  const n = a.length;
  const m = b.length;
  const trace = [];
  let v = new Int32Array(3);
  // v[k + d + 1] is the value for diagonal k in round d
  for (let d = 0; d <= Math.min(n + m, MAX_EDITS); d++) {
    trace.push(v);
    const next = new Int32Array(2 * d + 5);
    const get = (k) => v[k + d + 1];
    for (let k = -d; k <= d; k += 2) {
      // down (an added line) from diagonal k+1, or right (a removed line) from diagonal k-1
      let x = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? get(k + 1) : get(k - 1) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      next[k + d + 2] = x;
      if (x >= n && y >= m) {
        return backtrack(a, b, trace, n, m);
      }
    }
    v = next;
  }
  const ops = [];
  a.forEach((text, i) => ops.push({ mark: "-", a: i, text }));
  b.forEach((text, i) => ops.push({ mark: "+", b: i, text }));
  return ops;
}

// walk back from the end through the rounds, to find the lines that stayed, were removed, or were added
function backtrack(a, b, trace, x, y) {
  const ops = [];
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const get = (k) => v[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1;
    const prevX = get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ mark: " ", a: x, b: y, text: a[x] });
    }
    if (d > 0) {
      if (x === prevX) {
        y--;
        ops.push({ mark: "+", b: y, text: b[y] });
      } else {
        x--;
        ops.push({ mark: "-", a: x, text: a[x] });
      }
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

function splitLines(text) {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function cut(text) {
  return text.length > MAX_LINE_WIDTH ? text.slice(0, MAX_LINE_WIDTH - 3) + "..." : text;
}
