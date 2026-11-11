// keeping: which lines of a text to keep, for "run ... keeping" and "limit output keeping"
// see src/md/features/sandbox-run.md

// items from the start of the list, up to a count and a size in bytes
function takeItems(items, most, bytes) {
  const kept = [];
  let size = 0;
  for (const item of items) {
    size += Buffer.byteLength(item.text) + 1;
    if (kept.length >= most || size > bytes) {
      break;
    }
    kept.push(item);
  }
  return kept;
}

// items are [{ index, text }], in order; keep = { first, last, matches, bytes }:
// first and last are counts (null for none), matches is null or the positions in items of the lines that match a pattern,
// and bytes is null or the most bytes to keep; gives the items to keep, in order
export function keepItems(items, keep) {
  const bytes = keep.bytes === null ? Infinity : keep.bytes;
  if (keep.matches !== null) {
    return takeItems(keep.matches.map((position) => items[position]), Infinity, bytes);
  }
  const first = keep.first || 0;
  const last = keep.last || 0;
  // with both, each end gets half of the bytes
  const share = first > 0 && last > 0 ? bytes / 2 : bytes;
  const head = takeItems(items, first, share);
  const tail = takeItems([...items].reverse(), Math.min(last, items.length - head.length), share).reverse();
  // one very long line: the start of it
  if (head.length === 0 && tail.length === 0 && items.length > 0 && bytes !== Infinity && (first > 0 || last > 0)) {
    return [{ index: items[0].index, text: items[0].text.slice(0, Math.floor(bytes / 2)) }];
  }
  return [...head, ...tail];
}

// the kept items as lines, with a note in place of the cut lines: at each gap, or once at the end
// total is the count of the first lines; note(n) gives the text of a note for n cut lines
export function withNotes(kept, total, note, atEnd) {
  const cut = total - kept.length;
  if (cut === 0) {
    return { lines: kept.map((item) => item.text), cut };
  }
  if (atEnd) {
    return { lines: [...kept.map((item) => item.text), note(cut)], cut };
  }
  const lines = [];
  let next = 0;
  for (const item of kept) {
    if (item.index > next) {
      lines.push(note(item.index - next));
    }
    lines.push(item.text);
    next = item.index + 1;
  }
  if (next < total) {
    lines.push(note(total - next));
  }
  return { lines, cut };
}
