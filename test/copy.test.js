import { test } from "node:test";
import assert from "node:assert/strict";
import { copyCocktailInto } from "../src/sync/copy.js";

function home() {
  return {
    cocktails: [
      {
        id: "c1",
        name: "Gin Fizz",
        event: "e1",
        method: 1,
        glass: "g1",
        ingredients: [
          { id: "gin", unit: "ml", amount: 50 },
          { id: "syrup", unit: "ml", amount: 20 },
          { unit: "", amount: 0, id: undefined },
        ],
        garnishes: [{ id: "lemon", unit: "pcs", amount: 1 }],
        flavorCues: ["sour"],
      },
    ],
    ingredients: [
      { id: "gin", name: "Gin", ingredients: [], sources: [{ size: 700, price: 19, shopLink: "" }] },
      {
        id: "syrup",
        name: "Lemon syrup",
        ingredients: [
          { id: "sugar", unit: "g", amount: 500 },
          { id: "lemon", unit: "pcs", amount: 4 },
        ],
      },
      { id: "sugar", name: "Sugar", ingredients: [] },
      { id: "lemon", name: "Lemon", ingredients: [] },
    ],
    prepMethods: [
      { id: 0, name: "stirred" },
      { id: 1, name: "shaken" },
    ],
    glassTypes: [{ id: "g1", name: "Highball", volume: 350 }],
  };
}

test("copies a cocktail with everything it needs", () => {
  const target = {
    cocktails: [],
    ingredients: [{ id: "x", name: "sugar", ingredients: [] }],
    prepMethods: [
      { id: 0, name: "stirred" },
      { id: 1, name: "shaken" },
    ],
    glassTypes: [],
  };
  const id = copyCocktailInto(home(), "c1", target, { space: "automerge:home", heads: ["h"] });
  const cocktail = target.cocktails.find((c) => c.id === id);

  assert.notEqual(id, "c1");
  assert.equal(cocktail.event, "null");
  assert.deepEqual(cocktail.copiedFrom, { space: "automerge:home", id: "c1", heads: ["h"] });
  // The prep method exists with the same id and name, so it is reused.
  assert.equal(cocktail.method, 1);
  assert.equal(target.prepMethods.length, 2);
  // The glass is copied.
  assert.equal(target.glassTypes.length, 1);
  assert.equal(cocktail.glass, target.glassTypes[0].id);

  const byId = new Map(target.ingredients.map((i) => [i.id, i]));
  const names = cocktail.ingredients.map((row) => byId.get(row.id)?.name);
  assert.deepEqual(names, ["Gin", "Lemon syrup", undefined]);
  // Sub-recipes come along; "Sugar" matches the existing "sugar" by name.
  const syrup = byId.get(cocktail.ingredients[1].id);
  assert.deepEqual(
    syrup.ingredients.map((row) => byId.get(row.id).name),
    ["sugar", "Lemon"],
  );
  // The garnish and the syrup share one copy of the lemon.
  assert.equal(cocktail.garnishes[0].id, syrup.ingredients[1].id);
  assert.equal(target.ingredients.length, 4);
});

test("copying twice reuses what the first copy brought", () => {
  const target = { cocktails: [], ingredients: [], prepMethods: [], glassTypes: [] };
  copyCocktailInto(home(), "c1", target, { space: "automerge:home" });
  // Renamed in the target, so only the provenance can match it.
  target.ingredients.find((i) => i.name === "Gin").name = "London dry gin";
  copyCocktailInto(home(), "c1", target, { space: "automerge:home" });
  assert.equal(target.cocktails.length, 2);
  assert.equal(target.ingredients.length, 4);
  assert.equal(target.glassTypes.length, 1);
  assert.equal(target.prepMethods.length, 1);
});

test("the source is left untouched", () => {
  const source = home();
  const before = JSON.stringify(source);
  copyCocktailInto(source, "c1", { cocktails: [], ingredients: [] }, { space: "s" });
  assert.equal(JSON.stringify(source), before);
});
