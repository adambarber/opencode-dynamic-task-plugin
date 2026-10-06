/**
 * Finding the object literals in a source that restate a production record.
 *
 * Lives here rather than in the suite that asserts on it: a rule that reads
 * production and the tests both need those four imports, and inlining it in the
 * suite made the jscpd gate report its own import block as a clone.
 */
//jscpd:ignore-start
import { TESTS_DIR, listTestFiles, readProductionSource, readSource } from "./corpus.js";
import path from "node:path";

//jscpd:ignore-end
/**
 * A record shape is declared once, in production, and the tests BUILD it there.
 *
 * This scanner is the guard for a defect class the suite could not see. A test
 * fixture that spells a record out by hand is a second declaration of a shape with
 * no compiler over it, and it drifts in both directions at once: a fixture carrying
 * a field production deleted, and a fixture missing a field production requires.
 * Both were live here — a retained fixture kept `timeoutNotified` long after the
 * removal of `timeout_ms`, and an active fixture shipped a `lastNotice` with no
 * `claim`, which is the field the settlement reads to tell a blocked child from a
 * finished one, so a fixture used in a settlement would have settled a blocked
 * child as a success. 456 tests passed over both. jscpd cannot see either: it
 * pools TypeScript and JavaScript separately, so a test's copy of a production
 * shape is invisible to it by construction — the detector had to be written, which
 * is why it is here.
 *
 * The rule reads each interface's OWN field names out of the .ts source — required
 * ones included, `extends` followed — and then looks for an object literal in a
 * test file that spells all of them. A literal that carries every required field
 * is a restatement of the record, wherever it sits: the answer is to build it
 * through the production builder, not to have a second copy of the shape.
 */

/**
 * Two lists, two questions. SHAPE_HOMES is where every named shape is DECLARED —
 * resolution only, so an `extends` crossing a module boundary can be followed.
 * RECORD_SHAPES is the subset whose construction is a builder's job, so restating one
 * is drift; `DeliveryTarget` is in the first only, because production spells that
 * identity triple inline at every `notifyRecord` call and a builder would teach nothing.
 */
export const SHAPE_HOMES = [
  { file: "shared/task-records.ts", name: "TaskRecordBase" },
  { file: "shared/task-records.ts", name: "ActiveTaskState" },
  { file: "shared/settled-record.ts", name: "RetainedTaskState" },
  { file: "shared/task-formatting.ts", name: "TaskResultRecord" },
  { file: "shared/notify-queue.ts", name: "DeliveryTarget" },
  { file: "shared/notify-records.ts", name: "NotificationRecord" },
  { file: "shared/notify-queue.ts", name: "PendingDelivery" },
];

const RECORD_SHAPES = SHAPE_HOMES.filter((shape) => shape.name !== "DeliveryTarget");

/** The module that declares a named shape, or null when no listed shape declares it. */
const fileOf = (shape) => SHAPE_HOMES.find((s) => s.name === shape)?.file ?? null;

/** Every field an interface requires, following `extends` wherever the base is declared. */
function requiredFieldsOf(file, name, seen = new Set()) {
  if (seen.has(name)) return [];
  seen.add(name);
  const source = readProductionSource(file).text;
  const declaration = new RegExp(`(?:export )?interface ${name}\\b([^\\{]*)\\{`).exec(source);
  // A base may live in another module — `RetainedTaskState` extends `TaskRecordBase`,
  // and the settled record was moved to its own file while the base stayed with the
  // store's vocabulary. Resolving by name across the corpus is what lets a shape
  // change address without this rule having to be told where to look.
  if (!declaration) {
    const home = fileOf(name);
    assertKnownShape(home, name, file);
    return requiredFieldsOf(home, name, seen);
  }
  const open = declaration.index + declaration[0].length;
  let depth = 1;
  let close = open;
  for (let i = open; i < source.length && depth > 0; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") depth--;
    close = i;
  }
  const body = source.slice(open, close);
  const required = [...body.matchAll(/^\s*([A-Za-z][A-Za-z0-9]*)\s*[?:]/gm)]
    .filter(([, field]) => !body.match(new RegExp(`^\\s*${field}\\s*\\?`, "m")))
    .map(([, field]) => field);
  const inherited = /extends\s+([A-Za-z][A-Za-z0-9]*)/.exec(declaration[1]);
  return inherited ? [...requiredFieldsOf(fileOf(inherited[1]) ?? file, inherited[1], seen), ...required] : required;
}

/** A shape the rule cannot place is a shape that no longer exists; that must be loud. */
function assertKnownShape(home, name, file) {
  if (home) return;
  throw new Error(`${name} is not declared in ${file}, and no known shape declares it — this rule reads a shape that no longer exists`);
}

/**
 * Every object literal in a source, with its top-level keys — the keys a
 * restatement of a record would spell. A key has to sit at the start of its own
 * line or just inside the brace, which is what keeps `foo.bar` from reading as a
 * key named `bar`; string keys count, because a restatement may quote them.
 */
function objectLiterals(source) {
  const KEY = /^\s*([A-Za-z][A-Za-z0-9]*|"[A-Za-z][A-Za-z0-9]*"|'[A-Za-z][A-Za-z0-9]*')\s*[:,]/;
  const literals = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== "{") continue;
    let depth = 0;
    const keys = [];
    for (let j = i; j < source.length; j++) {
      const ch = source[j];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          if (keys.length > 0) literals.push({ keys, offset: i });
          i = j;
          break;
        }
      } else if (depth === 1 && "\"'`".includes(ch)) {
        for (j++; j < source.length && source[j] !== ch; j++) {
          if (source[j] === "\\") j++;
        }
      } else if (depth === 1) {
        const key = KEY.exec(source.slice(j, j + 80));
        // The character before the key has to end a token, or the "key" is the
        // tail of a longer one: in `foo.bar:` the scan reaches `bar` and must not
        // read it as a key.
        if (key && !/[\w.]/.test(j > 0 ? source[j - 1] : "")) {
          keys.push(key[1].replace(/["']/g, ""));
          j += key[0].length - 1;
        }
      }
    }
  }
  return literals;
}

const RECORDS_FIXTURE = path.join(TESTS_DIR, "support", "records.js");

/** Every suite file plus the record fixture — the one list of places a shape may be spelled. */
const RESTATEMENT_CORPUS = [...listTestFiles(), RECORDS_FIXTURE];

/**
 * Every test-side literal that spells a production record field-for-field, with the
 * file and line it sits on. The caller decides what an empty list should read as.
 */
export function recordShapeRestatements() {
  return RECORD_SHAPES.flatMap((shape) => {
    const required = requiredFieldsOf(shape.file, shape.name);
    if (required.length < 3) throw new Error(`${shape.name} yields only ${required.length} required field(s) — the extractor is not reading the shape`);
    return RESTATEMENT_CORPUS.flatMap((file) => restatementsIn(readSource(file), shape, required));
  });
}

/** The literals in one file that spell `shape`'s fields, described for a failure message. */
function restatementsIn({ file: name, text: source }, shape, required) {
  return objectLiterals(source)
    .filter((literal) => required.every((field) => literal.keys.includes(field)))
    .map((literal) => `${name}: ${shape.name} restated at line ${source.slice(0, literal.offset).split("\n").length} — build it with the production builder instead`);
}