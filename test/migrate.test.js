import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateData, SHAKEN_ID, STIRRED_ID } from "../src/migrate.js";

test("the default prep methods get their fixed UUIDs", () => {
  const custom = "c0ffee00-0000-4000-8000-000000000000";
  const data = migrateData({
    prepMethods: [
      { id: 0, name: "stirred" },
      { id: 1, name: "Shaken hard" },
      { id: custom, name: "thrown" },
    ],
    cocktails: [
      { id: "a", method: 0 },
      { id: "b", method: 1 },
      { id: "c", method: custom },
      { id: "d", method: "" },
      { id: "e" },
    ],
  });
  assert.deepEqual(data.prepMethods.map((m) => m.id), [STIRRED_ID, SHAKEN_ID, custom]);
  assert.deepEqual(data.cocktails.map((c) => c.method), [STIRRED_ID, SHAKEN_ID, custom, "", undefined]);
  // Running it again changes nothing.
  assert.deepEqual(migrateData(structuredClone(data)), data);
});

test("data without prep methods or cocktails is fine", () => {
  assert.deepEqual(migrateData({}), {});
  assert.equal(migrateData(null), null);
});
