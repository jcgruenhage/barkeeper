import { test } from "node:test";
import assert from "node:assert/strict";
import { copyCocktailInto, copyIngredientInto } from "../src/sync/copy.js";

function home() {
  return {
    cocktails: [
      {
        id: "c1",
        name: "Gin Fizz",
        event: "e1",
        method: "m-shaken",
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
      { id: "gin", name: "Gin", ingredients: [], sizes: [{ id: "s700", size: 700, sources: [{ id: "shop", price: 19, shopLink: "" }] }] },
      {
        id: "syrup",
        name: "Simple syrup",
        ingredients: [
          { id: "water", unit: "ml", amount: 500 },
          { id: "sugar", unit: "g", amount: 500 },
        ],
      },
      { id: "water", name: "Water", ingredients: [] },
      { id: "sugar", name: "Sugar", ingredients: [] },
      { id: "lemon", name: "Lemon", ingredients: [] },
    ],
    prepMethods: [
      { id: "m-stirred", name: "stirred" },
      { id: "m-shaken", name: "shaken" },
    ],
    glassTypes: [{ id: "g1", name: "Highball", volume: 350 }],
  };
}

const names = (list) => list.map((r) => r.name).sort();

test("copies a cocktail with everything it needs, keeping ids", () => {
  const target = {
    cocktails: [],
    // Same id as the source's sugar: the same record, so it is not copied.
    // Same name as the source's water, different id: a different record.
    ingredients: [
      { id: "sugar", name: "Cane sugar", ingredients: [] },
      { id: "w2", name: "Water", ingredients: [] },
    ],
    prepMethods: [
      { id: "m-stirred", name: "stirred" },
      { id: "m-shaken", name: "shaken" },
    ],
    glassTypes: [],
    events: [],
  };
  assert.deepEqual(copyCocktailInto(home(), "c1", target), { copied: true });

  const cocktail = target.cocktails[0];
  assert.equal(cocktail.id, "c1");
  // The event does not exist in the target.
  assert.equal(cocktail.event, "null");
  assert.deepEqual(cocktail.ingredients, JSON.parse(JSON.stringify(home().cocktails[0].ingredients)));
  assert.equal(target.prepMethods.length, 2);
  assert.deepEqual(target.glassTypes, home().glassTypes);
  assert.deepEqual(names(target.ingredients), ["Cane sugar", "Gin", "Lemon", "Simple syrup", "Water", "Water"]);
});

test("copying again changes nothing", () => {
  const target = { cocktails: [], ingredients: [], prepMethods: [], glassTypes: [] };
  copyCocktailInto(home(), "c1", target);
  const before = JSON.stringify(target);
  assert.deepEqual(copyCocktailInto(home(), "c1", target), { copied: false });
  assert.equal(JSON.stringify(target), before);
});

test("a cocktail keeps its event if the target has it", () => {
  const target = { events: [{ id: "e1", name: "GPN" }] };
  copyCocktailInto(home(), "c1", target);
  assert.equal(target.cocktails[0].event, "e1");
});

test("copies an ingredient with its sub-recipes, recursively", () => {
  const source = home();
  source.ingredients.unshift({
    id: "tonic",
    name: "Tonic syrup",
    ingredients: [
      { id: "syrup", unit: "ml", amount: 200 },
      { id: "quinine", unit: "g", amount: 5 },
    ],
  });
  source.ingredients.push({ id: "quinine", name: "Cinchona bark", ingredients: [] });
  const target = { ingredients: [{ id: "water", name: "Tap water", ingredients: [] }] };

  assert.deepEqual(copyIngredientInto(source, "tonic", target), { copied: true });
  assert.deepEqual(names(target.ingredients), ["Cinchona bark", "Simple syrup", "Sugar", "Tap water", "Tonic syrup"]);
  const syrup = target.ingredients.find((i) => i.id === "syrup");
  assert.deepEqual(syrup.ingredients.map((row) => row.id), ["water", "sugar"]);

  assert.deepEqual(copyIngredientInto(source, "syrup", target), { copied: false });
  assert.equal(target.ingredients.length, 5);
});

test("the source is left untouched", () => {
  const source = home();
  const before = JSON.stringify(source);
  copyCocktailInto(source, "c1", { cocktails: [], ingredients: [] });
  copyIngredientInto(source, "syrup", {});
  assert.equal(JSON.stringify(source), before);
});
