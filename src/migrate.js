// Upgrades barkeeper data from earlier versions in place.

// The default prep methods used to have the ids 0 and 1. Every other record
// has a UUID, and records are matched across spaces by id, so the defaults
// get fixed UUIDs that are the same in every space.
export const STIRRED_ID = "37ead6e5-971c-418b-9c65-2eb9e717b49b";
export const SHAKEN_ID = "f065e002-f9f0-4b58-8bc2-6b410cfdfa09";

const LEGACY_PREP_METHOD_IDS = new Map([
  [0, STIRRED_ID],
  [1, SHAKEN_ID],
]);

/**
 * A UUID-shaped id derived from `parts`, so that devices migrating the same
 * record at the same time come up with the same id. Not a real UUID version.
 */
export function derivedId(...parts) {
  const input = JSON.stringify(parts);
  let hex = "";
  // Four 32-bit FNV-1a hashes with different offsets make up 128 bits.
  for (const offset of [0x811c9dc5, 0x01000193, 0xdeadbeef, 0x9e3779b9]) {
    let hash = offset;
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    hex += (hash >>> 0).toString(16).padStart(8, "0");
  }
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

function uniqueById(records) {
  const byId = new Map();
  for (const record of records) {
    if (!byId.has(record.id)) byId.set(record.id, record);
  }
  return [...byId.values()];
}

// Ingredients used to have a flat list of sources, each with its own size.
// Now they have sizes, each with the sources that sell it. The new records get
// derived ids, and sizes with the same id are merged, so a space that two
// devices migrated at the same time is cleaned up the next time it is opened.
function migrateSizes(ingredient) {
  if (Array.isArray(ingredient.sources)) {
    ingredient.sizes ??= [];
    for (const source of ingredient.sources) {
      const size = Number(source?.size ?? 0);
      const price = Number(source?.price ?? 0);
      const shopLink = source?.shopLink ?? "";
      const id = derivedId("size", ingredient.id, size);
      let entry = ingredient.sizes.find((s) => s.id === id);
      if (!entry) {
        entry = { id, size, sources: [] };
        ingredient.sizes.push(entry);
      }
      entry.sources.push({ id: derivedId("source", ingredient.id, size, price, shopLink), price, shopLink });
    }
    delete ingredient.sources;
  }
  if (!Array.isArray(ingredient.sizes)) return;

  const duplicated = (list) => new Set(list.map((r) => r.id)).size !== list.length;
  if (duplicated(ingredient.sizes)) {
    const merged = new Map();
    for (const size of ingredient.sizes) {
      const first = merged.get(size.id);
      if (first) first.sources.push(...(size.sources ?? []));
      else merged.set(size.id, size);
    }
    ingredient.sizes = [...merged.values()];
  }
  for (const size of ingredient.sizes) {
    size.sources ??= [];
    if (duplicated(size.sources)) size.sources = uniqueById(size.sources);
  }
}

/**
 * Upgrade `data` in place. Every change is deterministic, so devices that
 * upgrade the same space at the same time write the same values.
 */
export function migrateData(data) {
  for (const method of data?.prepMethods ?? []) {
    if (LEGACY_PREP_METHOD_IDS.has(method.id)) method.id = LEGACY_PREP_METHOD_IDS.get(method.id);
  }
  for (const cocktail of data?.cocktails ?? []) {
    if (LEGACY_PREP_METHOD_IDS.has(cocktail.method)) {
      cocktail.method = LEGACY_PREP_METHOD_IDS.get(cocktail.method);
    }
  }
  for (const ingredient of data?.ingredients ?? []) migrateSizes(ingredient);
  return data;
}
