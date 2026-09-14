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
  return data;
}
