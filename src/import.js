// Importing recipes from a file into the open space, merging rather than
// replacing.
//
// The file is barkeeper-shaped JSON: cocktails, and the ingredients, prep
// methods and glasses they use. It is meant to be produced from a menu, a
// recipe sheet or a PDF, so records refer to each other by name as readily as
// by id, and anything a cocktail mentions may be left undeclared:
//
//   {
//     "barkeeperImport": 1,
//     "cocktails": [
//       {
//         "name": "Last Word",
//         "method": "shaken",
//         "glass": "Coupe",
//         "ingredients": [{ "name": "Gin", "amount": 1, "unit": "fl oz" }],
//         "garnishes": [{ "name": "Lime zest", "amount": 1, "unit": "pcs" }]
//       }
//     ],
//     "ingredients": [{ "name": "Gin", "abv": 0.43, "baseUnit": "ml" }]
//   }
//
// Importing happens in two steps. `planImport` works out, for every record the
// file mentions, whether the space already has it — by id, then by name — and
// what else it could be meant to be. Nothing is matched on a guess: a record
// that only resembles an existing one is left for the review screen to decide,
// because a wrong match silently rewrites a recipe while a duplicate is merely
// untidy. `applyImport` then carries out the plan, which the review screen may
// have changed.

import { ingredientUnits } from "./units.js";
import {
  defaultCocktail,
  defaultGlassType,
  defaultIngredient,
  defaultPrepMethod,
} from "./records.js";

export const IMPORT_VERSION = 1;

const KINDS = ["ingredients", "prepMethods", "glassTypes", "cocktails"];

const LABELS = {
  ingredients: "ingredient",
  prepMethods: "prep method",
  glassTypes: "glass",
  cocktails: "cocktail",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid() {
  return globalThis.crypto.randomUUID();
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function looksLikeId(value) {
  return typeof value === "string" && UUID.test(value);
}

/**
 * A name reduced to what two spellings of the same thing have in common:
 * case, accents and punctuation all dropped.
 */
export function normalizeName(name) {
  return String(name ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(normalized) {
  return new Set(normalized.split(" ").filter(Boolean));
}

/**
 * How alike two normalized names are, from 0 to 1. Shared words count, and so
 * does one name containing the other ("gin" in "london dry gin"), which the
 * shared-word count alone rates poorly.
 */
export function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = tokens(a);
  const tb = tokens(b);
  let shared = 0;
  for (const token of ta) if (tb.has(token)) shared++;
  const jaccard = shared / (ta.size + tb.size - shared);
  const contained =
    a.includes(b) || b.includes(a) ? Math.min(a.length, b.length) / Math.max(a.length, b.length) : 0;
  return Math.max(jaccard, contained * 0.9);
}

const SUGGESTION_THRESHOLD = 0.34;
const MAX_SUGGESTIONS = 6;

// An index of the records a space already has, by id and by normalized name.
function index(records) {
  const byId = new Map();
  const byName = new Map();
  for (const record of records ?? []) {
    if (record?.id !== undefined && record.id !== null) byId.set(String(record.id), record);
    const key = normalizeName(record?.name);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(record);
  }
  return { byId, byName, records: records ?? [] };
}

function suggestions(target, name, excludeId) {
  const wanted = normalizeName(name);
  if (!wanted) return [];
  return target.records
    .filter((record) => record.id !== excludeId)
    .map((record) => ({ id: record.id, name: record.name, score: similarity(wanted, normalizeName(record.name)) }))
    .filter((candidate) => candidate.score >= SUGGESTION_THRESHOLD)
    .sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)))
    .slice(0, MAX_SUGGESTIONS);
}

/**
 * Turns a reference into the shape the planner looks records up by. A string
 * is an id if it is shaped like one and a name otherwise, so that a file may
 * write `"method": "shaken"` or `"method": "<uuid>"`.
 */
function asRef(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string" || typeof value === "number") {
    // A scalar may be either an id or a name: glasses and prep methods of older
    // spaces have small integer ids, while a file is as likely to write
    // "shaken". It is offered as both, and the lookup tries ids first.
    return { id: String(value), name: String(value) };
  }
  if (typeof value !== "object") return null;
  const ref = {};
  if (value.id !== undefined && value.id !== null && value.id !== "") ref.id = String(value.id);
  if (value.name !== undefined && value.name !== null && value.name !== "") ref.name = String(value.name);
  return ref.id || ref.name ? ref : null;
}

// Collects what a file mentions of one kind, and decides for each what it is.
class Plan {
  constructor(kind, targetRecords) {
    this.kind = kind;
    this.target = index(targetRecords);
    this.entries = [];
    this.byAlias = new Map();
  }

  alias(key, entry) {
    if (key && !this.byAlias.has(key)) this.byAlias.set(key, entry);
  }

  find(ref) {
    if (!ref) return null;
    if (ref.id && this.byAlias.has("id:" + ref.id)) return this.byAlias.get("id:" + ref.id);
    const key = normalizeName(ref.name);
    if (key && this.byAlias.has("name:" + key)) return this.byAlias.get("name:" + key);
    return null;
  }

  /**
   * The entry for `ref`, created if the file has not mentioned it before.
   * `record` is the file's full record where it declared one.
   */
  resolve(ref, record = null) {
    if (!ref) return null;
    const existing = this.find(ref);
    if (existing) {
      if (record && !existing.declared) {
        existing.declared = true;
        existing.incoming = record;
      }
      return existing;
    }

    const name = ref.name ?? record?.name ?? "";
    const entry = {
      kind: this.kind,
      key: `${this.kind}:${this.entries.length}`,
      label: LABELS[this.kind],
      name: String(name),
      incoming: record ?? (ref.id ? { id: ref.id, name } : { name }),
      declared: Boolean(record),
      // Which cocktails mention it, so the review screen can say why it is here.
      usedBy: [],
      matchedBy: null,
      ambiguous: false,
      candidates: [],
      decision: "create",
      targetId: null,
      needsReview: false,
    };

    entry.incomingName = String(name).trim();
    const byId = ref.id ? this.target.byId.get(ref.id) : undefined;
    if (byId) {
      entry.matchedBy = "id";
      entry.decision = "match";
      entry.targetId = byId.id;
      // Under the name the space gives it: a match is not a rename.
      entry.name = String(byId.name ?? name);
    } else {
      const named = this.target.byName.get(normalizeName(name)) ?? [];
      if (named.length === 1) {
        entry.matchedBy = "name";
        entry.decision = "match";
        entry.targetId = named[0].id;
        entry.name = String(named[0].name ?? name);
      } else if (named.length > 1) {
        entry.matchedBy = "name";
        entry.decision = "match";
        entry.targetId = named[0].id;
        entry.name = String(named[0].name ?? name);
        entry.ambiguous = true;
        entry.needsReview = true;
      }
    }

    entry.candidates = suggestions(this.target, entry.name, entry.targetId);
    // Nothing in the space carries this name, but something resembles it: the
    // one case where only a person can say whether it is the same thing.
    if (!entry.matchedBy && entry.candidates.length > 0) entry.needsReview = true;

    this.entries.push(entry);
    this.alias("id:" + (ref.id ?? record?.id ?? ""), entry);
    this.alias("name:" + normalizeName(entry.name), entry);
    return entry;
  }
}

function rowsOf(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * What importing `incoming` into `target` (barkeeper data) would do. The
 * returned plan is meant to be shown and changed before `applyImport` runs it:
 * every entry's `decision` may be set to "match" (with a `targetId`), "create"
 * or "skip".
 */
export function planImport(incoming, target) {
  const plans = {};
  for (const kind of KINDS) plans[kind] = new Plan(kind, target?.[kind]);
  const problems = [];

  const seenNames = { ingredients: new Map(), cocktails: new Map() };
  const noteDuplicate = (kind, name) => {
    const key = normalizeName(name);
    if (!key) return;
    const count = (seenNames[kind]?.get(key) ?? 0) + 1;
    seenNames[kind]?.set(key, count);
    if (count === 2) {
      problems.push(`The file lists more than one ${LABELS[kind]} called "${name}"; only the first is imported.`);
    }
  };

  // Ingredients first, so that a declared record wins over the bare mention of
  // it in a recipe, whichever order the file lists them in.
  for (const ingredient of rowsOf(incoming?.ingredients)) {
    const ref = asRef(ingredient);
    if (!ref) {
      problems.push("An ingredient in the file has neither a name nor an id; it is ignored.");
      continue;
    }
    noteDuplicate("ingredients", ingredient?.name);
    plans.ingredients.resolve(ref, ingredient);
  }
  for (const method of rowsOf(incoming?.prepMethods)) {
    const ref = asRef(method);
    if (ref) plans.prepMethods.resolve(ref, method);
  }
  for (const glass of rowsOf(incoming?.glassTypes)) {
    const ref = asRef(glass);
    if (ref) plans.glassTypes.resolve(ref, glass);
  }

  // Sub-recipes of declared ingredients, repeatedly: a sub-recipe may mention
  // an ingredient that has a recipe of its own.
  for (let depth = 0; depth < 32; depth++) {
    const before = plans.ingredients.entries.length;
    for (const entry of [...plans.ingredients.entries]) {
      if (!entry.declared) continue;
      for (const row of rowsOf(entry.incoming.ingredients)) {
        const child = plans.ingredients.resolve(asRef(row));
        if (child && !child.usedBy.includes(entry.name)) child.usedBy.push(entry.name);
      }
    }
    if (plans.ingredients.entries.length === before) break;
  }

  for (const cocktail of rowsOf(incoming?.cocktails)) {
    const ref = asRef(cocktail);
    if (!ref) {
      problems.push("A cocktail in the file has neither a name nor an id; it is ignored.");
      continue;
    }
    noteDuplicate("cocktails", cocktail?.name);
    const entry = plans.cocktails.resolve(ref, cocktail);
    if (!entry) continue;
    // A cocktail the space already has is not imported again by default: the
    // one there may have been edited since, and overwriting it is not a merge.
    if (entry.matchedBy) {
      entry.decision = "skip";
      entry.needsReview = true;
    }
    for (const row of [...rowsOf(cocktail.ingredients), ...rowsOf(cocktail.garnishes)]) {
      const used = plans.ingredients.resolve(asRef(row));
      if (used && !used.usedBy.includes(entry.name)) used.usedBy.push(entry.name);
    }
    const method = plans.prepMethods.resolve(asRef(cocktail.method));
    if (method && !method.usedBy.includes(entry.name)) method.usedBy.push(entry.name);
    const glass = plans.glassTypes.resolve(asRef(cocktail.glass));
    if (glass && !glass.usedBy.includes(entry.name)) glass.usedBy.push(entry.name);
  }

  // Again for sub-recipes, now that recipes may have pulled in new records.
  for (let depth = 0; depth < 32; depth++) {
    const before = plans.ingredients.entries.length;
    for (const entry of [...plans.ingredients.entries]) {
      if (!entry.declared) continue;
      for (const row of rowsOf(entry.incoming.ingredients)) {
        const child = plans.ingredients.resolve(asRef(row));
        if (child && !child.usedBy.includes(entry.name)) child.usedBy.push(entry.name);
      }
    }
    if (plans.ingredients.entries.length === before) break;
  }

  const plan = { version: IMPORT_VERSION, problems };
  for (const kind of KINDS) plan[kind] = plans[kind].entries;
  return plan;
}

/** Every entry of the plan that a person should look at before importing. */
export function reviewNeeded(plan) {
  return KINDS.flatMap((kind) => plan[kind] ?? []).filter((entry) => entry.needsReview);
}

export function planCounts(plan) {
  const counts = {};
  for (const kind of KINDS) {
    const entries = plan[kind] ?? [];
    counts[kind] = {
      create: entries.filter((e) => e.decision === "create").length,
      match: entries.filter((e) => e.decision === "match").length,
      skip: entries.filter((e) => e.decision === "skip").length,
    };
  }
  return counts;
}

// Ids of records to be created: the file's own where it is a usable id that
// nothing has taken, so that importing the same file twice is idempotent.
function assignIds(plan, target, newId) {
  const taken = new Set();
  for (const kind of KINDS) for (const record of target?.[kind] ?? []) taken.add(String(record?.id));
  const final = new Map();
  for (const kind of KINDS) {
    for (const entry of plan[kind] ?? []) {
      if (entry.decision === "match") {
        final.set(entry.key, entry.targetId);
      } else if (entry.decision === "create") {
        const wanted = entry.incoming?.id;
        const id = looksLikeId(wanted) && !taken.has(String(wanted)) ? String(wanted) : newId();
        taken.add(id);
        final.set(entry.key, id);
      } else {
        final.set(entry.key, null);
      }
    }
  }
  return final;
}

const INGREDIENT_FIELDS = [
  "baseUnit",
  "units",
  "yield",
  "allergens",
  "nonVeganIngredients",
  "notes",
  "safetyFactor",
  "abv",
  "color",
  "hideInShoppingList",
];

const COCKTAIL_FIELDS = [
  "notes",
  "cubes",
  "crushed",
  "largeCubes",
  "cubesServing",
  "crushedServing",
  "largeCubesServing",
  "numToPrep",
  "price",
  "flavorCues",
];

function overlay(record, incoming, fields) {
  for (const field of fields) {
    if (incoming?.[field] !== undefined) record[field] = clone(incoming[field]);
  }
  return record;
}

function sizesOf(incoming, newId) {
  return rowsOf(incoming?.sizes).map((size) => ({
    id: looksLikeId(size?.id) ? size.id : newId(),
    size: Number(size?.size ?? 0),
    sources: rowsOf(size?.sources).map((source) => ({
      id: looksLikeId(source?.id) ? source.id : newId(),
      price: Number(source?.price ?? 0),
      shopLink: String(source?.shopLink ?? ""),
    })),
  }));
}

/**
 * Carries out `plan`, mutating `target` (barkeeper data) in place. New
 * cocktails are filed under `event`, which is an event id, or 'null' for the
 * idea list in popup mode and the repertoire in bar mode.
 */
export function applyImport(target, plan, options = {}) {
  const { event = "null", onMenu = false, newId = uuid } = options;

  target.cocktails ??= [];
  target.ingredients ??= [];
  target.prepMethods ??= [];
  target.glassTypes ??= [];

  const ids = assignIds(plan, target, newId);
  const warnings = [];
  const dropped = new Set();

  const rowFor = (row, ownerName) => {
    const entry = findEntry(plan.ingredients, row);
    const id = entry ? ids.get(entry.key) : null;
    if (!id) {
      if (entry && !dropped.has(entry)) {
        dropped.add(entry);
        warnings.push(`"${entry.name}" was left out, so it is missing from ${ownerName}.`);
      }
      return null;
    }
    return { id, amount: Number(row?.amount ?? 0), unit: String(row?.unit ?? "") };
  };

  const rowsFor = (rows, ownerName) => rowsOf(rows).map((row) => rowFor(row, ownerName)).filter(Boolean);

  // Ingredients, then the records cocktails point at, then the cocktails.
  for (const entry of plan.ingredients ?? []) {
    if (entry.decision !== "create") continue;
    const id = ids.get(entry.key);
    const record = defaultIngredient(entry.name, () => id);
    overlay(record, entry.incoming, INGREDIENT_FIELDS);
    record.sizes = sizesOf(entry.incoming, newId);
    record.ingredients = rowsFor(entry.incoming?.ingredients, `"${entry.name}"`);
    target.ingredients.unshift(record);
  }

  for (const entry of plan.prepMethods ?? []) {
    if (entry.decision !== "create") continue;
    const record = defaultPrepMethod(entry.name, () => ids.get(entry.key));
    if (entry.incoming?.dilutionFormula !== undefined) {
      record.dilutionFormula = String(entry.incoming.dilutionFormula);
    }
    target.prepMethods.push(record);
  }

  for (const entry of plan.glassTypes ?? []) {
    if (entry.decision !== "create") continue;
    const record = defaultGlassType(entry.name, () => ids.get(entry.key));
    if (entry.incoming?.volume !== undefined) record.volume = Number(entry.incoming.volume);
    target.glassTypes.push(record);
  }

  const added = [];
  for (const entry of plan.cocktails ?? []) {
    if (entry.decision !== "create") continue;
    const id = ids.get(entry.key);
    const incoming = entry.incoming ?? {};
    const record = defaultCocktail(entry.name, event, () => id);
    overlay(record, incoming, COCKTAIL_FIELDS);
    record.ingredients = rowsFor(incoming.ingredients, `"${entry.name}"`);
    record.garnishes = rowsFor(incoming.garnishes, `"${entry.name}"`);
    record.method = idFor(plan.prepMethods, incoming.method, ids);
    record.glass = idFor(plan.glassTypes, incoming.glass, ids);
    target.cocktails.unshift(record);
    added.push({ id, name: record.name });
    if (onMenu) {
      target.bar ??= {};
      target.bar.cocktails ??= {};
      target.bar.cocktails[id] ??= {};
      target.bar.cocktails[id].onMenu = true;
    }
  }

  warnings.push(...unitWarnings(target, added));
  return { counts: planCounts(plan), cocktails: added, warnings };
}

function findEntry(entries, ref) {
  const wanted = asRef(ref);
  if (!wanted) return null;
  if (wanted.id) {
    const byId = (entries ?? []).find(
      (entry) => String(entry.incoming?.id ?? "") === wanted.id || entry.targetId === wanted.id,
    );
    if (byId) return byId;
  }
  const key = normalizeName(wanted.name);
  if (!key) return null;
  return (entries ?? []).find((entry) => normalizeName(entry.name) === key) ?? null;
}

function idFor(entries, ref, ids) {
  const entry = findEntry(entries, ref);
  if (!entry) return undefined;
  return ids.get(entry.key) ?? undefined;
}

/**
 * Units the space cannot convert. An amount in an unknown unit is counted as
 * if it were the base unit, which quietly throws off costs and strengths, so
 * it is worth saying out loud.
 */
function unitWarnings(target, added) {
  const table = target.settings?.unitConvTable ?? [];
  const unknown = new Map();
  const ids = new Set(added.map((c) => c.id));
  for (const cocktail of target.cocktails) {
    if (!ids.has(cocktail.id)) continue;
    for (const row of [...rowsOf(cocktail.ingredients), ...rowsOf(cocktail.garnishes)]) {
      const ingredient = target.ingredients.find((i) => i.id === row.id);
      if (!ingredient || !row.unit) continue;
      if (row.unit === ingredient.baseUnit) continue;
      const known = ingredientUnits(ingredient, table).some((entry) => entry[0] === row.unit);
      if (known) continue;
      if (!unknown.has(row.unit)) unknown.set(row.unit, new Set());
      unknown.get(row.unit).add(ingredient.name);
    }
  }
  return [...unknown].map(
    ([unit, names]) =>
      `This space has no conversion for "${unit}", so amounts in it count as ${
        [...names].length === 1 ? "the base unit" : "base units"
      } (${[...names].slice(0, 4).join(", ")}${names.size > 4 ? ", …" : ""}). Add one under settings.`,
  );
}

/**
 * Reads an import file. Returns the data to plan from, or throws with a
 * message worth showing.
 */
export function parseImport(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`That is not a JSON file: ${error.message}`);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("An import file has to be a JSON object.");
  }
  const version = data.barkeeperImport;
  if (version !== undefined && Number(version) > IMPORT_VERSION) {
    throw new Error(`This file was written for a newer barkeeper (import version ${version}).`);
  }
  const mentions = KINDS.some((kind) => rowsOf(data[kind]).length > 0);
  if (!mentions) throw new Error("There are no cocktails or ingredients in that file.");
  return data;
}
