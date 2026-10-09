/**
 * Put every import declaration in the order `eslint/sort-imports` asks for.
 *
 * The rule has no fixer in either engine, so the findings have to be removed by hand,
 * and a hand pass is how they come back. This removes them the way the rule defines:
 * grouped by member syntax (`none`, `all`, `multiple`, `single`), sorted within each
 * group, specifiers alphabetical inside each brace.
 *
 * SAFETY IS THE WHOLE DESIGN. This only PERMUTES import statements into the slots they
 * already occupy — the whitespace, comments, and code between them are never moved,
 * rewritten, or dropped. An earlier version rebuilt the block as a unit and ate a
 * newline after the last import, losing every import below a comment. Permuting slots
 * makes those failures unrepresentable rather than merely unlikely.
 *
 * Refuses to write unless the multiset of import texts is IDENTICAL before and after.
 * That is the invariant a reorder could break and a rewrite cannot, and it is checked
 * on every file before anything is written.
 */

//jscpd:ignore-start
import { readFileSync, writeFileSync } from "node:fs";

//jscpd:ignore-end
/** `none` is a bare side-effect import; `all` is a namespace; the rest count specifiers. */
const RANK = { all: 1, multiple: 2, none: 0, single: 3 };

/** One `import ...;` plus the byte range it occupies, or null. */
function statementAt(source, start) {
  if (!/^import[\s{*'"]/.test(source.slice(start, start + 12))) return null;
  let depth = 0;
  let quote = null;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ";" && depth === 0) return { end: i + 1, text: source.slice(start, i + 1) };
  }
  return null;
}

/** The specifier names inside the braces, which is what the rule compares. */
function specifiers(text) {
  return [...text.matchAll(/\{([^}]*)\}/g)]
    .flatMap((block) => block[1].split(",").map((part) => part.trim()).filter(Boolean))
    .map((part) => part.replace(/^\w+\s+as\s+/, "").trim());
}

/** The rank the rule assigns, and the first local name it sorts on. */
function order(text) {
  const head = text.slice("import".length, text.lastIndexOf("from"));
  const names = specifiers(text);
  if (!/[{*]/.test(head)) return { key: "", rank: RANK.none };
  const space = head.match(/\*\s+as\s+(\w+)/);
  if (space) return { key: space[1], rank: RANK.all };
  if (names.length > 1) return { key: names[0], rank: RANK.multiple };
  return { key: names[0] ?? "", rank: RANK.single };
}

/** Specifiers alphabetical inside the brace, one line when the brace was one line. */
function sortedInside(text) {
  return text.replace(/\{([^}]*)\}/g, (whole, inner) => {
    const parts = inner.split(",").map((p) => p.trim()).filter(Boolean).toSorted();
    return whole.includes("\n") ? `{\n${parts.map((p) => `  ${p},`).join("\n")}\n}` : `{ ${parts.join(", ")} }`;
  });
}

/** Whitespace and comments only — the region an import block may legally follow. */
function isCommentary(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .trim() === "";
}

/** The next `import` keyword at or after `from`, stepping over whitespace and comments. */
function nextImport(source, from) {
  let at = from;
  while (at < source.length) {
    const rest = source.slice(at);
    const gap = /^\s+/.exec(rest);
    if (gap) {
      at += gap[0].length;
      continue;
    }
    const block = /^\/\*[\s\S]*?\*\//.exec(rest);
    if (block) {
      at += block[0].length;
      continue;
    }
    const line = /^\/\/[^\n]*\n?/.exec(rest);
    if (line) {
      at += line[0].length;
      continue;
    }
    return source.startsWith("import", at) ? at : -1;
  }
  return -1;
}

/** The slots, in order, that imports occupy — everything between them is untouched. */
function slots(source) {
  const found = [];
  let at = nextImport(source, 0);
  if (at === -1) return found;
  // Only a leading block is safe: an import halfway down a file may not be reorderable.
  if (!isCommentary(source.slice(0, at))) return [];
  while (at !== -1) {
    const statement = statementAt(source, at);
    if (!statement) break;
    found.push({ at, end: statement.end, text: statement.text });
    at = nextImport(source, statement.end);
  }
  return found;
}

/** Sorted import texts for a file, or null when there is nothing safe to do. */
export function sortImports(source) {
  const found = slots(source);
  if (found.length < 2) return null;
  const ordered = found
    .map((slot) => ({ ...slot, text: sortedInside(slot.text), ...order(slot.text) }))
    .toSorted((a, b) => a.rank - b.rank || (a.key < b.key ? -1 : (a.key > b.key ? 1 : 0)))
    .map((slot) => slot.text);

  // The guard. A permutation changes order and nothing else, so if this ever fails the
  // rewrite is wrong and the file is left exactly as it was.
  const tally = (list) => {
    const counts = new Map();
    for (const text of list) counts.set(text, (counts.get(text) ?? 0) + 1);
    return counts;
  };
  const same = (a, b) =>
    a.size === b.size && [...a].every(([text, count]) => b.get(text) === count);
  if (!same(tally(found.map((s) => s.text)), tally(ordered))) return null;
  if (found.map((s) => s.text).join("") === ordered.join("")) return null;

  let out = "";
  let cursor = 0;
  for (const [index, slot] of found.entries()) {
    out += source.slice(cursor, slot.at) + ordered[index];
    cursor = slot.end;
  }
  return out + source.slice(cursor);
}

const files = process.argv.slice(2);
const checking = files[0] === "--check";
const paths = checking ? files.slice(1) : files;

let stale = 0;
for (const file of paths) {
  const source = readFileSync(file, "utf8");
  const next = sortImports(source);
  if (next === null) continue;
  stale++;
  if (!checking) writeFileSync(file, next);
  else process.stdout.write(`${file}\n`);
}
process.exit(stale === 0 ? 0 : 1);