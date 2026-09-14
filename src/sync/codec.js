// Translates between barkeeper's plain JSON data (the "view", which the UI
// mutates in place and which export/import use) and a space document that
// merges cleanly when edited concurrently.
//
// A space document looks like this:
//
//   {
//     barkeeper: 1,
//     name: "GPN",
//     names: { <member id hex>: "Anna" },
//     rows: {
//       root: { '["settings","costDistMinimaNum"]': 5, ... },
//       <random key>: { $p: "root", $f: '["cocktails"]', $o: "a0", '["name"]': "Negroni", ... },
//     },
//   }
//
// Every array of records in the view (cocktails, the ingredients of a cocktail,
// the equipment of an event, ...) becomes a set of rows. A row points at its
// parent row and field, carries a fractional order key, and holds its own
// scalar values flattened into leaves keyed by their JSON-encoded path. Rows
// are the only nested maps, and each is created by exactly one peer under a
// random key, so no two peers ever race to create the same map. That keeps
// every edit a last-write-wins update of a single leaf, and reordering touches
// only the order keys of the rows that actually moved.
//
// Nested objects inside a row are flattened too, with a marker leaf so that
// empty objects and arrays survive the round trip. Arrays of plain values are
// either sets (tags, one leaf per member), tuples (one leaf per index) or, if
// the schema does not know them, a single JSON-encoded leaf.

import * as A from "@automerge/automerge";
import { generateNKeysBetween } from "fractional-indexing";

export const DOC_VERSION = 1;
export const ROOT = "root";

const MARK_OBJ = "\u0000{}";
const MARK_ARR = "\u0000[]";
const JSON_PREFIX = "\u0000json:";
const ORDER_PREFIX = "\u0000o:";

// Paths use "*" for any array index or object key.
export const SCHEMA = {
  rows: [
    "cocktails",
    "cocktails.*.ingredients",
    "cocktails.*.garnishes",
    "ingredients",
    "ingredients.*.ingredients",
    "ingredients.*.units",
    "ingredients.*.sources",
    "events",
    "events.*.barProgram.equipment",
    "events.*.barProgram.cocktailsSold",
    "prepMethods",
    "glassTypes",
    "settings.unitConvTable",
  ],
  sets: [
    "cocktails.*.flavorCues",
    "ingredients.*.allergens",
    "ingredients.*.nonVeganIngredients",
  ],
  tuples: [
    "ingredients.*.units.*",
    "settings.unitConvTable.*",
    "settings.costDistRange",
  ],
  // Stored as one value, so concurrent edits never mix two of them.
  atomic: ["events.*.barProgram.sources.*"],
  // Never synced: derived data, and settings that belong to the device.
  local: ["events.*.barProgram.recipes", "settings.darkMode"],
};

function compile(schema) {
  const kinds = { rows: "rows", sets: "set", tuples: "tuple", atomic: "atomic", local: "local" };
  const table = [];
  for (const [group, patterns] of Object.entries(schema)) {
    for (const pattern of patterns) {
      table.push({ kind: kinds[group], segments: pattern.split(".") });
    }
  }
  return (path) => {
    for (const { kind, segments } of table) {
      if (segments.length !== path.length) continue;
      let match = true;
      for (let i = 0; i < segments.length; i++) {
        if (segments[i] !== "*" && segments[i] !== String(path[i])) {
          match = false;
          break;
        }
      }
      if (match) return kind;
    }
    return null;
  };
}

const kindOf = compile(SCHEMA);

export function isLocalPath(path) {
  return kindOf(path) === "local";
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof A.ImmutableString)
  );
}

function plainValue(value) {
  if (value instanceof A.ImmutableString) return value.toString();
  return value;
}

function compareRows(a, b) {
  if (a.order < b.order) return -1;
  if (a.order > b.order) return 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

export function randomKey() {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// view -> leaves

/**
 * Flatten the value of one row into leaves, the row collections found inside
 * it, and the members of its sets.
 */
function flattenRow(value, prefix) {
  const leaves = new Map();
  const children = [];
  const sets = [];

  const walk = (current, rel) => {
    if (current === undefined || typeof current === "function") return;
    const path = prefix.concat(rel);
    const kind = rel.length > 0 ? kindOf(path) : null;
    const key = JSON.stringify(rel);

    if (kind === "local") return;

    if (kind === "rows" && Array.isArray(current)) {
      leaves.set(key, MARK_ARR);
      children.push({ field: rel, items: Array.from(current) });
      return;
    }
    if (kind === "set" && Array.isArray(current)) {
      leaves.set(key, MARK_ARR);
      sets.push({ field: rel, members: Array.from(current) });
      return;
    }
    if (kind === "atomic") {
      leaves.set(key, JSON_PREFIX + JSON.stringify(current));
      return;
    }
    if (Array.isArray(current)) {
      if (rel.length > 0 && kind !== "tuple") {
        leaves.set(key, JSON_PREFIX + JSON.stringify(current));
        return;
      }
      if (rel.length > 0) leaves.set(key, MARK_ARR);
      current.forEach((item, index) => walk(item, rel.concat(index)));
      return;
    }
    if (isPlainObject(current)) {
      if (rel.length > 0) leaves.set(key, MARK_OBJ);
      for (const k of Object.keys(current)) walk(current[k], rel.concat(k));
      return;
    }
    if (rel.length === 0) return;
    if (typeof current === "number" && !Number.isFinite(current)) {
      leaves.set(key, null);
      return;
    }
    leaves.set(key, current);
  };

  walk(value, []);
  return { leaves, children, sets, isArray: Array.isArray(value) };
}

// ---------------------------------------------------------------------------
// ordering

/**
 * Work out new order keys for a sequence. `items` is the desired order, each
 * with the order key it currently has in the document (or null). Only items
 * outside the longest run that is already in order get a new key.
 */
export function assignOrders(items) {
  const n = items.length;
  // Longest strictly increasing subsequence of existing order keys.
  const tails = [];
  const tailIndex = [];
  const prev = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const order = items[i].order;
    if (typeof order !== "string") continue;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < order) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = order;
    tailIndex[lo] = i;
    prev[i] = lo > 0 ? tailIndex[lo - 1] : -1;
  }
  const keep = new Set();
  for (let i = tailIndex[tails.length - 1] ?? -1; i !== -1; i = prev[i]) {
    keep.add(i);
  }

  const result = new Array(n);
  let i = 0;
  while (i < n) {
    if (keep.has(i)) {
      result[i] = items[i].order;
      i++;
      continue;
    }
    let j = i;
    while (j < n && !keep.has(j)) j++;
    const before = i > 0 ? result[i - 1] : null;
    const after = j < n ? items[j].order : null;
    let keys;
    try {
      keys = generateNKeysBetween(before, after, j - i);
    } catch {
      // Malformed keys from a peer. Renumber everything from scratch.
      return generateNKeysBetween(null, null, n);
    }
    for (let k = i; k < j; k++) result[k] = keys[k - i];
    i = j;
  }
  return result;
}

// ---------------------------------------------------------------------------
// view -> document

function writeLeaf(d, rowKey, row, key, value) {
  const current = row[key];
  if (typeof value === "string" && !value.startsWith("\u0000")) {
    if (typeof current === "string") {
      if (current !== value) A.updateText(d, ["rows", rowKey, key], value);
      return;
    }
    row[key] = value;
    return;
  }
  if (typeof value === "string") {
    if (plainValue(current) !== value || typeof current === "string") {
      row[key] = new A.ImmutableString(value);
    }
    return;
  }
  if (current !== value) row[key] = value;
}

function setMeta(row, key, value) {
  if (value === null || value === undefined) {
    if (key in row) delete row[key];
    return;
  }
  if (plainValue(row[key]) !== value) row[key] = new A.ImmutableString(value);
}

function newRowObject(leaves, meta) {
  const row = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value !== null && value !== undefined) {
      row[key] = new A.ImmutableString(value);
    }
  }
  for (const [key, value] of leaves) {
    row[key] =
      typeof value === "string" && value.startsWith("\u0000")
        ? new A.ImmutableString(value)
        : value;
  }
  return row;
}

/**
 * Bring a document (inside a change callback) in line with the view.
 *
 * `keyOf` maps raw view objects to row keys and is updated for new rows.
 * `toRaw` unwraps reactive proxies. Rows missing from the view are deleted,
 * so the callback must see the document as it was when the view was last
 * materialized (use changeAt with those heads), or concurrent rows that the
 * view has not seen yet would be deleted.
 */
export function applyView(d, view, keyOf, toRaw = (x) => x) {
  if (!d.rows) d.rows = {};
  if (d.barkeeper !== DOC_VERSION) d.barkeeper = DOC_VERSION;

  // Existing rows grouped by parent and field.
  const groups = new Map();
  for (const key of Object.keys(d.rows)) {
    const row = d.rows[key];
    if (key === ROOT) continue;
    const group = `${plainValue(row.$p)}|${plainValue(row.$f)}`;
    if (!groups.has(group)) groups.set(group, new Set());
    groups.get(group).add(key);
  }

  const seen = new Set();

  const syncRow = (rowKey, value, prefix, meta) => {
    seen.add(rowKey);
    const { leaves, children, sets, isArray } = flattenRow(value, prefix);
    if (isArray) leaves.set("$t", MARK_ARR);
    let row = d.rows[rowKey];

    for (const { field, members } of sets) {
      const existing = members.map((member) => {
        const leafKey = JSON.stringify(field.concat([member]));
        const current = row ? plainValue(row[leafKey]) : undefined;
        const order =
          typeof current === "string" && current.startsWith(ORDER_PREFIX)
            ? current.slice(ORDER_PREFIX.length)
            : null;
        return { leafKey, order };
      });
      // Duplicates collapse into one member.
      const unique = [];
      const seenMembers = new Set();
      for (const item of existing) {
        if (seenMembers.has(item.leafKey)) continue;
        seenMembers.add(item.leafKey);
        unique.push(item);
      }
      const orders = assignOrders(unique);
      unique.forEach((item, i) =>
        leaves.set(item.leafKey, ORDER_PREFIX + orders[i]),
      );
    }

    if (!row) {
      d.rows[rowKey] = newRowObject(leaves, meta);
      row = d.rows[rowKey];
    } else {
      for (const [key, value] of Object.entries(meta)) setMeta(row, key, value);
      for (const [key, value] of leaves) writeLeaf(d, rowKey, row, key, value);
      for (const key of Object.keys(row)) {
        if (key.startsWith("$") && key !== "$t") continue;
        if (!leaves.has(key)) delete row[key];
      }
    }

    for (const { field, items } of children) {
      const fieldKey = JSON.stringify(field);
      const group = groups.get(`${rowKey}|${fieldKey}`) ?? new Set();
      const childPrefix = prefix.concat(field, ["*"]);
      const planned = items.map((item) => {
        const raw = item !== null && typeof item === "object" ? toRaw(item) : item;
        let key = raw !== null && typeof raw === "object" ? keyOf.get(raw) : undefined;
        if (!key || !group.has(key) || seen.has(key)) {
          key = randomKey();
          if (raw !== null && typeof raw === "object" && !keyOf.has(raw)) {
            keyOf.set(raw, key);
          }
        }
        seen.add(key);
        const existing = d.rows[key];
        return {
          key,
          item,
          order: existing ? plainValue(existing.$o) : null,
        };
      });
      const orders = assignOrders(planned);
      planned.forEach(({ key, item }, i) => {
        seen.delete(key);
        syncRow(key, item, childPrefix, { $p: rowKey, $f: fieldKey, $o: orders[i] });
      });
    }
  };

  syncRow(ROOT, view, [], {});

  for (const key of Object.keys(d.rows)) {
    if (!seen.has(key)) delete d.rows[key];
  }
}

/** A fresh space document for the given view. */
export function createDoc(view, name, keyOf = new WeakMap(), toRaw) {
  const doc = A.change(A.init(), (d) => {
    d.barkeeper = DOC_VERSION;
    d.name = new A.ImmutableString(name);
    d.names = {};
    d.rows = {};
    applyView(d, view, keyOf, toRaw);
  });
  return doc;
}

/**
 * The initial value to hand to repo.create2(). Same shape as createDoc(), but
 * as a plain object.
 */
export function initialValue(view, name, keyOf = new WeakMap(), toRaw) {
  const value = {
    barkeeper: DOC_VERSION,
    name: new A.ImmutableString(name),
    names: {},
    rows: {},
  };
  // applyView only needs a mutable object tree; updateText is never reached
  // because every row is new.
  applyView(value, view, keyOf, toRaw);
  return value;
}

// ---------------------------------------------------------------------------
// document -> view

/**
 * Build the view from a document. Row objects are registered in `keyOf`.
 */
export function materialize(doc, keyOf = new WeakMap()) {
  const rows = doc?.rows ?? {};
  const childrenOf = new Map();
  for (const key of Object.keys(rows)) {
    if (key === ROOT) continue;
    const row = rows[key];
    const group = `${plainValue(row.$p)}|${plainValue(row.$f)}`;
    if (!childrenOf.has(group)) childrenOf.set(group, []);
    childrenOf.get(group).push({ key, order: String(plainValue(row.$o) ?? "") });
  }
  for (const list of childrenOf.values()) list.sort(compareRows);

  const build = (rowKey, prefix, visiting) => {
    const row = rows[rowKey] ?? {};
    const isArray = plainValue(row.$t) === MARK_ARR;
    const value = isArray ? [] : {};
    const setOrders = new Map();

    const entries = Object.keys(row)
      .filter((key) => !key.startsWith("$"))
      .map((key) => {
        try {
          return { path: JSON.parse(key), raw: plainValue(row[key]) };
        } catch {
          return null;
        }
      })
      .filter((entry) => Array.isArray(entry?.path) && entry.path.length > 0)
      .sort((a, b) => a.path.length - b.path.length);

    const containerAt = (path, create) => {
      let current = value;
      for (let i = 0; i < path.length; i++) {
        const segment = path[i];
        let next = current[segment];
        if (next === null || typeof next !== "object") {
          if (!create) return undefined;
          const kind = kindOf(prefix.concat(path.slice(0, i + 1)));
          next =
            kind === "rows" || kind === "set" || kind === "tuple" ? [] : {};
          current[segment] = next;
        }
        current = next;
      }
      return current;
    };

    for (const { path, raw } of entries) {
      const parentPath = path.slice(0, -1);
      const last = path[path.length - 1];
      const parentKind = parentPath.length > 0 ? kindOf(prefix.concat(parentPath)) : null;

      if (parentKind === "set") {
        const set = containerAt(parentPath, true);
        if (!Array.isArray(set)) continue;
        if (!setOrders.has(set)) setOrders.set(set, []);
        const order =
          typeof raw === "string" && raw.startsWith(ORDER_PREFIX)
            ? raw.slice(ORDER_PREFIX.length)
            : "";
        setOrders.get(set).push({ key: String(last), order, member: last });
        continue;
      }

      const parent = containerAt(parentPath, true);
      if (parent === undefined || parent === null || typeof parent !== "object") continue;

      if (raw === MARK_OBJ) {
        if (parent[last] === null || typeof parent[last] !== "object") parent[last] = {};
      } else if (raw === MARK_ARR) {
        if (!Array.isArray(parent[last])) parent[last] = [];
      } else if (typeof raw === "string" && raw.startsWith(JSON_PREFIX)) {
        try {
          parent[last] = JSON.parse(raw.slice(JSON_PREFIX.length));
        } catch {
          parent[last] = null;
        }
      } else {
        parent[last] = raw;
      }
    }

    for (const [set, members] of setOrders) {
      members.sort(compareRows);
      set.splice(0, set.length, ...members.map((m) => m.member));
    }

    if (isArray) {
      // Tuples: fill holes so indices line up.
      for (let i = 0; i < value.length; i++) if (!(i in value)) value[i] = null;
    }

    for (const [group, list] of childrenOf) {
      const [parentKey, fieldKey] = [
        group.slice(0, group.indexOf("|")),
        group.slice(group.indexOf("|") + 1),
      ];
      if (parentKey !== rowKey) continue;
      let field;
      try {
        field = JSON.parse(fieldKey);
      } catch {
        continue;
      }
      if (!Array.isArray(field) || field.length === 0) continue;
      const parent = containerAt(field.slice(0, -1), true);
      if (parent === undefined || typeof parent !== "object") continue;
      const last = field[field.length - 1];
      if (!Array.isArray(parent[last])) parent[last] = [];
      const target = parent[last];
      target.length = 0;
      const childPrefix = prefix.concat(field, ["*"]);
      for (const { key } of list) {
        if (visiting.has(key)) continue;
        visiting.add(key);
        const child = build(key, childPrefix, visiting);
        visiting.delete(key);
        target.push(child);
      }
    }

    keyOf.set(value, rowKey);
    return value;
  };

  return build(ROOT, [], new Set([ROOT]));
}

// ---------------------------------------------------------------------------
// merge a freshly materialized view into the live one

/**
 * Update `target` (the live, reactive view) in place so that it equals
 * `source`, reusing existing row objects where the keys match so that the UI
 * keeps its DOM and input focus. Local-only paths are left alone.
 */
export function reconcile(
  target,
  source,
  keyOf,
  toRaw = (x) => x,
  path = [],
  visited = new WeakSet(),
) {
  // The UI sometimes shares one object between two places (copying a record
  // without cloning it). Each place gets its own copy from the document, so an
  // object that was already reconciled elsewhere is replaced, never reused.
  visited.add(toRaw(target));
  const fresh = (value) =>
    value !== null && typeof value === "object" && !visited.has(toRaw(value));

  if (Array.isArray(target) && Array.isArray(source)) {
    const rowsKind = path.length > 0 && kindOf(path) === "rows";
    if (rowsKind) {
      const available = new Map();
      for (const item of target) {
        const raw = item !== null && typeof item === "object" ? toRaw(item) : item;
        const key = raw !== null && typeof raw === "object" ? keyOf.get(raw) : undefined;
        if (key && !available.has(key)) available.set(key, item);
      }
      const next = source.map((item) => {
        const key = item !== null && typeof item === "object" ? keyOf.get(item) : undefined;
        const existing = key ? available.get(key) : undefined;
        if (fresh(existing)) {
          available.delete(key);
          const sameShape = Array.isArray(existing) === Array.isArray(item);
          if (sameShape) {
            reconcile(existing, item, keyOf, toRaw, path.concat("*"), visited);
            return existing;
          }
        }
        return item;
      });
      const same =
        next.length === target.length &&
        next.every((item, i) => toRaw(item) === toRaw(target[i]));
      if (!same) target.splice(0, target.length, ...next);
      return;
    }
    const sameLength = target.length === source.length;
    for (let i = 0; i < source.length; i++) {
      const t = target[i];
      const s = source[i];
      if (
        fresh(t) && s !== null && typeof s === "object" &&
        Array.isArray(t) === Array.isArray(s)
      ) {
        reconcile(t, s, keyOf, toRaw, path.concat("*"), visited);
      } else if (!Object.is(t, s)) {
        target[i] = s;
      }
    }
    if (!sameLength && target.length > source.length) {
      target.splice(source.length);
    }
    return;
  }

  for (const key of Object.keys(source)) {
    const childPath = path.concat(key);
    if (isLocalPath(childPath)) continue;
    const t = target[key];
    const s = source[key];
    if (
      fresh(t) && s !== null && typeof s === "object" &&
      Array.isArray(t) === Array.isArray(s) &&
      kindOf(childPath) !== "atomic"
    ) {
      reconcile(t, s, keyOf, toRaw, childPath, visited);
    } else if (kindOf(childPath) === "atomic") {
      if (JSON.stringify(t) !== JSON.stringify(s)) target[key] = s;
    } else if (!Object.is(t, s)) {
      target[key] = s;
    }
  }
  for (const key of Object.keys(target)) {
    const childPath = path.concat(key);
    if (isLocalPath(childPath)) continue;
    if (!(key in source) && target[key] !== undefined) delete target[key];
  }
}
