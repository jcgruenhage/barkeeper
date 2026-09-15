import { test } from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import {
  applyView,
  assignOrders,
  createDoc,
  materialize,
  reconcile,
} from "../src/sync/codec.js";
import { migrateData } from "../src/migrate.js";

function sample() {
  return {
    cocktails: [
      {
        id: "c1",
        name: "Negroni",
        ingredients: [
          { id: "gin", unit: "ml", amount: 30 },
          { id: "campari", unit: "ml", amount: 30 },
          { id: "vermouth", unit: "ml", amount: 30 },
        ],
        garnishes: [{ id: "orange", unit: "pcs", amount: 1 }],
        notes: "Stir, strain over a large cube.",
        cubes: 0,
        largeCubesServing: 1,
        method: 0,
        glass: "g1",
        event: "e1",
        numToPrep: 40,
        price: 9.5,
        flavorCues: ["bitter", "herbal"],
      },
    ],
    ingredients: [
      {
        id: "gin",
        name: "Gin",
        baseUnit: "ml",
        units: [["bottle", 700]],
        ingredients: [],
        yield: 0,
        sizes: [
          {
            id: "s700",
            size: 700,
            sources: [
              { id: "shop1", price: 18.99, shopLink: "https://example.org" },
              { id: "shop2", price: 21.5, shopLink: "" },
            ],
          },
          { id: "s1000", size: 1000, sources: [] },
        ],
        allergens: [],
        nonVeganIngredients: [],
        notes: "",
        safetyFactor: 0.1,
        abv: 0.4,
        color: "#e9ecef",
        hideInShoppingList: false,
      },
    ],
    events: [
      {
        id: "e1",
        name: "GPN",
        barProgram: {
          ice: { cubeID: "i1", cubeSize: 25, cubeBagWeight: 4, cubeBagCost: 0 },
          equipment: [],
          purchases: { gin: { comment: "", expense: 0, checked: false } },
          sources: { gin: { size: 700, price: 18.99, shopLink: "https://example.org" } },
          cocktailsSold: [{ c1: 12 }, {}],
          recipes: { derived: true },
        },
      },
    ],
    prepMethods: [{ id: 0, name: "stirred", dilutionFormula: "1 + abv" }],
    glassTypes: [{ id: "g1", name: "Rocks", volume: 300 }],
    settings: {
      costDistRange: [50, 200],
      costDistMinimaNum: 5,
      costDistMinimaThreshold: 7,
      unitConvTable: [["oz", "ml", 29.57]],
      darkMode: true,
    },
  };
}

function withoutLocal(view) {
  const copy = structuredClone(view);
  delete copy.settings.darkMode;
  for (const event of copy.events) delete event.barProgram.recipes;
  return copy;
}

// One peer: a document plus the view it last materialized.
class Peer {
  constructor(doc) {
    this.doc = doc;
    this.keyOf = new WeakMap();
    this.view = materialize(doc, this.keyOf);
    this.heads = A.getHeads(doc);
  }
  edit(fn) {
    fn(this.view);
    const { newDoc } = A.changeAt(this.doc, this.heads, (d) =>
      applyView(d, this.view, this.keyOf),
    );
    this.doc = newDoc;
    this.refresh();
  }
  refresh() {
    const fresh = materialize(this.doc, this.keyOf);
    reconcile(this.view, fresh, this.keyOf);
    this.heads = A.getHeads(this.doc);
  }
  receive(other) {
    this.doc = A.merge(this.doc, A.clone(other.doc));
    this.refresh();
  }
}

function pair() {
  const doc = createDoc(sample(), "GPN");
  const a = new Peer(A.clone(doc));
  const b = new Peer(A.clone(doc));
  return [a, b];
}

function sync(a, b) {
  a.receive(b);
  b.receive(a);
}

test("round trip keeps the data, minus local-only fields", () => {
  const doc = createDoc(sample(), "GPN");
  assert.deepEqual(materialize(doc), withoutLocal(sample()));
  assert.equal(doc.name.toString(), "GPN");
});

test("an unchanged view produces no change", () => {
  const [a] = pair();
  const before = A.getHeads(a.doc);
  a.edit(() => {});
  assert.deepEqual(A.getHeads(a.doc), before);
});

test("concurrent edits to different fields of one record both survive", () => {
  const [a, b] = pair();
  a.edit((v) => (v.cocktails[0].price = 10));
  b.edit((v) => (v.cocktails[0].numToPrep = 60));
  sync(a, b);
  assert.equal(a.view.cocktails[0].price, 10);
  assert.equal(a.view.cocktails[0].numToPrep, 60);
  assert.deepEqual(a.view, b.view);
});

test("concurrent edits to one number converge on a single value", () => {
  const [a, b] = pair();
  a.edit((v) => (v.events[0].barProgram.cocktailsSold[0].c1 = 40));
  b.edit((v) => (v.events[0].barProgram.cocktailsSold[0].c1 = 42));
  sync(a, b);
  const sold = a.view.events[0].barProgram.cocktailsSold[0].c1;
  assert.ok(sold === 40 || sold === 42);
  assert.deepEqual(a.view, b.view);
});

test("concurrent text edits merge", () => {
  const [a, b] = pair();
  a.edit((v) => (v.cocktails[0].notes = "Stir well, strain over a large cube."));
  b.edit((v) => (v.cocktails[0].notes = "Stir, strain over a large clear cube."));
  sync(a, b);
  assert.equal(a.view.cocktails[0].notes, "Stir well, strain over a large clear cube.");
});

test("concurrently added rows are both kept", () => {
  const [a, b] = pair();
  a.edit((v) => v.cocktails[0].garnishes.push({ id: "cherry", unit: "pcs", amount: 1 }));
  b.edit((v) => v.cocktails[0].garnishes.push({ id: "peel", unit: "pcs", amount: 1 }));
  sync(a, b);
  const ids = a.view.cocktails[0].garnishes.map((g) => g.id).sort();
  assert.deepEqual(ids, ["cherry", "orange", "peel"]);
  assert.deepEqual(a.view, b.view);
});

test("sources nested in sizes merge like any other rows", () => {
  const [a, b] = pair();
  a.edit((v) => v.ingredients[0].sizes[0].sources.push({ id: "shop3", price: 17, shopLink: "c" }));
  b.edit((v) => {
    v.ingredients[0].sizes[0].size = 750;
    v.ingredients[0].sizes[0].sources[0].price = 19.49;
  });
  sync(a, b);
  const [size] = a.view.ingredients[0].sizes;
  assert.equal(size.size, 750);
  assert.deepEqual(size.sources.map((s) => [s.id, s.price]), [["shop1", 19.49], ["shop2", 21.5], ["shop3", 17]]);
  assert.deepEqual(a.view, b.view);
});

test("sizes migrated by two devices at once are merged on the next migration", () => {
  const legacy = sample();
  legacy.ingredients[0].sources = [
    { size: 700, price: 18.99, shopLink: "https://example.org" },
    { size: 700, price: 21.5, shopLink: "" },
    { size: 1000, price: 25, shopLink: "" },
  ];
  delete legacy.ingredients[0].sizes;
  const doc = createDoc(legacy, "GPN");
  const a = new Peer(A.clone(doc));
  const b = new Peer(A.clone(doc));
  a.edit((v) => migrateData(v));
  b.edit((v) => migrateData(v));
  sync(a, b);
  assert.equal(a.view.ingredients[0].sizes.length, 4);
  assert.equal(a.view.ingredients[0].sources, undefined);

  a.edit((v) => migrateData(v));
  sync(a, b);
  const sizes = b.view.ingredients[0].sizes;
  assert.deepEqual(sizes.map((s) => s.size), [700, 1000]);
  assert.deepEqual(sizes[0].sources.map((s) => s.price), [18.99, 21.5]);
  assert.deepEqual(a.view, b.view);
});

test("bar state keyed by id merges per entry and per field", () => {
  const [a, b] = pair();
  a.edit((v) => {
    v.settings.mode = "bar";
    v.bar = { cocktails: { c1: { onMenu: true } } };
  });
  sync(a, b);
  a.edit((v) => (v.bar.cocktails.c1.onMenu = false));
  b.edit((v) => (v.bar.cocktails.c2 = { onMenu: true }));
  sync(a, b);
  assert.deepEqual(a.view.bar, { cocktails: { c1: { onMenu: false }, c2: { onMenu: true } } });
  assert.equal(b.view.settings.mode, "bar");
  assert.deepEqual(a.view, b.view);
  a.edit((v) => delete v.bar.cocktails.c2);
  sync(a, b);
  assert.deepEqual(Object.keys(b.view.bar.cocktails), ["c1"]);
});

test("a row added before the view saw a remote change is not deleted", () => {
  const [a, b] = pair();
  b.edit((v) => v.glassTypes.push({ id: "g2", name: "Coupe", volume: 180 }));
  // a receives the change but edits from a view that predates it.
  a.doc = A.merge(a.doc, A.clone(b.doc));
  a.edit((v) => (v.glassTypes[0].volume = 320));
  assert.deepEqual(
    a.view.glassTypes.map((g) => [g.name, g.volume]),
    [["Rocks", 320], ["Coupe", 180]],
  );
});

test("swapping rows only rewrites order keys and merges with edits", () => {
  const [a, b] = pair();
  a.edit((v) => {
    const list = v.cocktails[0].ingredients;
    list[0] = list.splice(1, 1, list[0])[0];
  });
  b.edit((v) => (v.cocktails[0].ingredients[0].amount = 45));
  sync(a, b);
  assert.deepEqual(
    a.view.cocktails[0].ingredients.map((i) => [i.id, i.amount]),
    [["campari", 30], ["gin", 45], ["vermouth", 30]],
  );
});

test("filtering a row out deletes it", () => {
  const [a, b] = pair();
  a.edit((v) => {
    v.cocktails[0].ingredients = v.cocktails[0].ingredients.filter((i) => i.id !== "campari");
  });
  sync(a, b);
  assert.deepEqual(b.view.cocktails[0].ingredients.map((i) => i.id), ["gin", "vermouth"]);
});

test("rows start without an id and get one later", () => {
  const [a, b] = pair();
  a.edit((v) => v.cocktails[0].ingredients.push({ unit: "", amount: 0, id: undefined }));
  a.edit((v) => (v.cocktails[0].ingredients[3].id = "soda"));
  sync(a, b);
  assert.equal(b.view.cocktails[0].ingredients[3].id, "soda");
  assert.equal(b.view.cocktails[0].ingredients.length, 4);
});

test("tags behave like a set", () => {
  const [a, b] = pair();
  a.edit((v) => v.cocktails[0].flavorCues.push("citrus"));
  b.edit((v) => {
    v.cocktails[0].flavorCues = v.cocktails[0].flavorCues.filter((c) => c !== "herbal");
    v.cocktails[0].flavorCues.push("boozy");
  });
  sync(a, b);
  assert.deepEqual([...a.view.cocktails[0].flavorCues].sort(), ["bitter", "boozy", "citrus"]);
  assert.deepEqual(a.view, b.view);
});

test("records under deterministic keys created concurrently merge", () => {
  const [a, b] = pair();
  a.edit((v) => (v.events[0].barProgram.purchases.ice = { comment: "", expense: 12, checked: false }));
  b.edit((v) => (v.events[0].barProgram.purchases.ice = { comment: "Metro", expense: 0, checked: false }));
  sync(a, b);
  const ice = a.view.events[0].barProgram.purchases.ice;
  assert.ok(ice.expense === 12 || ice.expense === 0);
  assert.deepEqual(a.view, b.view);
});

test("tuples keep their positions", () => {
  const [a, b] = pair();
  a.edit((v) => (v.settings.costDistRange[1] = 250));
  b.edit((v) => (v.ingredients[0].units[0][1] = 750));
  sync(a, b);
  assert.deepEqual(a.view.settings.costDistRange, [50, 250]);
  assert.deepEqual(a.view.ingredients[0].units, [["bottle", 750]]);
});

test("a selected source is replaced as a whole", () => {
  const [a, b] = pair();
  a.edit((v) => (v.events[0].barProgram.sources.gin = { size: 1000, price: 22, shopLink: "a" }));
  b.edit((v) => (v.events[0].barProgram.sources.gin = { size: 500, price: 14, shopLink: "b" }));
  sync(a, b);
  const source = a.view.events[0].barProgram.sources.gin;
  assert.ok(
    JSON.stringify(source) === JSON.stringify({ size: 1000, price: 22, shopLink: "a" }) ||
      JSON.stringify(source) === JSON.stringify({ size: 500, price: 14, shopLink: "b" }),
  );
});

test("local-only fields stay on the device", () => {
  const [a, b] = pair();
  a.view.settings.darkMode = false;
  b.view.settings.darkMode = true;
  a.edit((v) => (v.events[0].barProgram.recipes = { other: 1 }));
  sync(a, b);
  assert.equal(a.view.settings.darkMode, false);
  assert.equal(b.view.settings.darkMode, true);
  assert.ok(!JSON.stringify(a.doc).includes("recipes"));
});

test("reconcile keeps row objects so the UI keeps its DOM", () => {
  const [a, b] = pair();
  const cocktail = a.view.cocktails[0];
  const gin = cocktail.ingredients[0];
  b.edit((v) => (v.cocktails[0].name = "Negroni Sbagliato"));
  a.receive(b);
  assert.equal(a.view.cocktails[0], cocktail);
  assert.equal(a.view.cocktails[0].ingredients[0], gin);
  assert.equal(cocktail.name, "Negroni Sbagliato");
});

test("a record copied without cloning is split into two independent rows", () => {
  const [a, b] = pair();
  a.edit((v) => {
    const c = v.cocktails[0];
    v.cocktails.unshift({ ...c, id: "c2", ingredients: c.ingredients, flavorCues: c.flavorCues });
  });
  const heads = A.getHeads(a.doc);
  a.edit((v) => (v.cocktails[0].ingredients[0].amount = 60));
  assert.equal(a.view.cocktails[1].ingredients[0].amount, 30);
  assert.equal(a.view.cocktails[0].ingredients[0].amount, 60);
  // Nothing keeps changing once the copies are separate.
  const settled = A.getHeads(a.doc);
  a.edit(() => {});
  assert.deepEqual(A.getHeads(a.doc), settled);
  assert.notDeepEqual(heads, settled);
  sync(a, b);
  assert.deepEqual(a.view, b.view);
});

test("assignOrders keeps what is already in order", () => {
  const orders = assignOrders([
    { order: "a0" },
    { order: null },
    { order: "a2" },
    { order: "a1" },
  ]);
  assert.equal(orders[0], "a0");
  // Two of the three existing keys are already in order and stay put.
  const kept = ["a0", "a1", "a2"].filter((key) => orders.includes(key));
  assert.equal(kept.length, 2);
  assert.ok(orders[0] < orders[1] && orders[1] < orders[2] && orders[2] < orders[3]);
});
