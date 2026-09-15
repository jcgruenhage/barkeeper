import { test } from "node:test";
import assert from "node:assert/strict";
import { derivedId, migrateData, SHAKEN_ID, STIRRED_ID } from "../src/migrate.js";

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

test("flat sources become sizes with their sources", () => {
  const data = migrateData({
    ingredients: [
      {
        id: "gin",
        sources: [
          { size: 700, price: 18.99, shopLink: "shop a" },
          { size: 1000, price: 25, shopLink: "shop a" },
          { size: 700, price: 21.5, shopLink: "shop b" },
        ],
      },
      { id: "syrup", ingredients: [{ id: "sugar" }], sources: [] },
      { id: "new", sizes: [{ id: "s", size: 500, sources: [] }] },
    ],
  });
  const [gin, syrup, fresh] = data.ingredients;
  assert.equal(gin.sources, undefined);
  assert.deepEqual(
    gin.sizes.map((s) => [s.size, s.sources.map((o) => [o.price, o.shopLink])]),
    [
      [700, [[18.99, "shop a"], [21.5, "shop b"]]],
      [1000, [[25, "shop a"]]],
    ],
  );
  assert.equal(gin.sizes[0].id, derivedId("size", "gin", 700));
  assert.deepEqual(syrup.sizes, []);
  assert.deepEqual(fresh.sizes, [{ id: "s", size: 500, sources: [] }]);
  // Running it again changes nothing.
  assert.deepEqual(migrateData(structuredClone(data)), data);
});

test("derived ids are stable and look like UUIDs", () => {
  assert.equal(derivedId("size", "gin", 700), derivedId("size", "gin", 700));
  assert.notEqual(derivedId("size", "gin", 700), derivedId("size", "gin", 1000));
  assert.match(derivedId("x"), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("duplicate sizes and sources are merged", () => {
  const data = migrateData({
    ingredients: [
      {
        id: "gin",
        sizes: [
          { id: "s700", size: 700, sources: [{ id: "a", price: 1 }, { id: "a", price: 1 }] },
          { id: "s700", size: 700, sources: [{ id: "a", price: 1 }, { id: "b", price: 2 }] },
        ],
      },
    ],
  });
  assert.deepEqual(data.ingredients[0].sizes, [
    { id: "s700", size: 700, sources: [{ id: "a", price: 1 }, { id: "b", price: 2 }] },
  ]);
});

test("gives legacy glasses derived uuids and repoints the cocktails", () => {
  const data = {
    glassTypes: [
      { id: 1, name: "Coupe", volume: 200 },
      { id: 2, name: "Tumbler", volume: 300 },
      { id: "fb9acfbb-2169-4394-98d7-626efc05d9f4", name: "Tumbler", volume: 0 },
    ],
    cocktails: [
      { id: "c1", name: "Bramble", glass: 2 },
      { id: "c2", name: "Daiquiri", glass: 1 },
      { id: "c3", name: "Negroni", glass: "fb9acfbb-2169-4394-98d7-626efc05d9f4" },
      { id: "c4", name: "Sour", glass: undefined },
    ],
  };
  migrateData(data);

  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  for (const glass of data.glassTypes) assert.match(glass.id, uuid);
  assert.equal(data.glassTypes[2].id, "fb9acfbb-2169-4394-98d7-626efc05d9f4");
  assert.equal(data.cocktails[0].glass, data.glassTypes[1].id);
  assert.equal(data.cocktails[1].glass, data.glassTypes[0].id);
  assert.equal(data.cocktails[2].glass, "fb9acfbb-2169-4394-98d7-626efc05d9f4");
  assert.equal(data.cocktails[3].glass, undefined);
  // Two glasses of the same name stay two glasses, with ids of their own.
  assert.notEqual(data.glassTypes[1].id, data.glassTypes[2].id);
});

test("migrating glasses twice is the same as migrating them once", () => {
  const data = {
    glassTypes: [{ id: 1, name: "Coupe", volume: 200 }],
    cocktails: [{ id: "c1", glass: 1 }],
  };
  migrateData(data);
  const once = JSON.stringify(data);
  migrateData(data);
  assert.equal(JSON.stringify(data), once);
});
