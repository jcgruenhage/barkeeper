import { test } from "node:test";
import assert from "node:assert/strict";
import { foldSizeIntoLoose, makeable, serveNeeds, stockAmount } from "../src/bar.js";

const gin = {
  id: "gin",
  sizes: [
    { id: "s700", size: 700, sources: [] },
    { id: "s1000", size: 1000, sources: [] },
  ],
};

test("stock adds up counted sizes and the loose amount", () => {
  assert.equal(stockAmount(gin, undefined), undefined);
  assert.equal(stockAmount(gin, {}), 0);
  assert.equal(stockAmount(gin, { counts: { s700: 2.5, s1000: 1 }, loose: 50 }), 2800);
  // A size that no longer exists and values that are not numbers count as nothing.
  assert.equal(stockAmount(gin, { counts: { gone: 3, s700: "" }, loose: null }), 0);
  assert.equal(stockAmount({ id: "syrup", ingredients: [] }, { loose: 300 }), 300);
});

test("removing a size keeps its stock as a loose amount", () => {
  const entry = { counts: { s700: 1.5, s1000: 1 }, loose: 20 };
  foldSizeIntoLoose(entry, gin.sizes[0]);
  assert.deepEqual(entry, { counts: { s1000: 1 }, loose: 1070 });
  foldSizeIntoLoose(entry, { id: "uncounted", size: 500 });
  assert.deepEqual(entry, { counts: { s1000: 1 }, loose: 1070 });
  foldSizeIntoLoose(undefined, gin.sizes[0]);
});

// Last Word and Closing Argument share everything but the base spirit.
function homeBar() {
  const bottle = (id, size) => ({ id, size, sources: [] });
  const ingredient = (id, extra = {}) => ({ id, name: id, baseUnit: "ml", units: [], ingredients: [], yield: 0, safetyFactor: 0, sizes: [], ...extra });
  const shared = [
    { id: "chartreuse", unit: "ml", amount: 22.5 },
    { id: "maraschino", unit: "ml", amount: 22.5 },
    { id: "lime", unit: "ml", amount: 22.5 },
  ];
  return {
    cocktails: [
      { id: "last-word", ingredients: [{ id: "gin", unit: "ml", amount: 22.5 }, ...shared], garnishes: [] },
      { id: "closing-argument", ingredients: [{ id: "mezcal", unit: "ml", amount: 22.5 }, ...shared], garnishes: [] },
    ],
    ingredients: [
      ingredient("gin", { sizes: [bottle("gin-700", 700)] }),
      ingredient("mezcal", { sizes: [bottle("mezcal-700", 700)] }),
      ingredient("chartreuse", { sizes: [bottle("chartreuse-700", 700)] }),
      ingredient("maraschino", { sizes: [bottle("maraschino-700", 700)] }),
      ingredient("lime"),
    ],
    bar: { cocktails: {}, stock: {}, par: {} },
    settings: { unitConvTable: [["oz", "ml", 30]] },
  };
}

const cocktailOf = (data, id) => data.cocktails.find((c) => c.id === id);

test("a serve needs each ingredient in its base unit, with the safety factor", () => {
  const data = homeBar();
  data.ingredients.find((i) => i.id === "gin").safetyFactor = 0.5;
  const lastWord = cocktailOf(data, "last-word");
  lastWord.ingredients[1] = { id: "chartreuse", unit: "oz", amount: 0.75 };
  lastWord.garnishes = [{ id: "lime", unit: "ml", amount: 5 }];
  assert.deepEqual(
    Object.fromEntries(serveNeeds(data, lastWord)),
    { gin: 33.75, chartreuse: 22.5, maraschino: 22.5, lime: 27.5 },
  );
});

test("sub-recipes are broken down unless they are stocked", () => {
  const data = homeBar();
  // 500 ml of honey syrup from 300 ml honey and 250 ml water, and a 10 %
  // safety factor on the syrup itself.
  data.ingredients.push(
    { id: "honey-syrup", ingredients: [{ id: "honey", unit: "ml", amount: 300 }, { id: "water", unit: "ml", amount: 250 }], yield: 500, safetyFactor: 0.1, baseUnit: "ml" },
    { id: "honey", ingredients: [], safetyFactor: 0, baseUnit: "ml" },
    { id: "water", ingredients: [], safetyFactor: 0, baseUnit: "ml" },
    { id: "broken", ingredients: [{ id: "honey", unit: "ml", amount: 1 }], yield: 0, safetyFactor: 0, baseUnit: "ml" },
  );
  const beesKnees = { id: "bees-knees", ingredients: [{ id: "gin", unit: "ml", amount: 60 }, { id: "honey-syrup", unit: "ml", amount: 20 }, { id: "broken", unit: "ml", amount: 1 }], garnishes: [] };

  const brokenDown = Object.fromEntries(serveNeeds(data, beesKnees));
  assert.equal(brokenDown.gin, 60);
  assert.ok(Math.abs(brokenDown.honey - 13.2) < 1e-9);
  assert.ok(Math.abs(brokenDown.water - 11) < 1e-9);
  // A sub-recipe without a yield cannot be broken down.
  assert.equal(brokenDown.broken, 1);

  const stocked = Object.fromEntries(serveNeeds(data, beesKnees, (id) => id === "honey-syrup"));
  assert.deepEqual(stocked, { gin: 60, "honey-syrup": 22, broken: 1 });
});

test("a sub-recipe that lists itself does not loop forever", () => {
  const data = homeBar();
  data.ingredients.push({ id: "loop", ingredients: [{ id: "loop", unit: "ml", amount: 1 }], yield: 1, safetyFactor: 0, baseUnit: "ml" });
  assert.deepEqual(Object.fromEntries(serveNeeds(data, { ingredients: [{ id: "loop", unit: "ml", amount: 2 }] })), { loop: 2 });
});

test("the stock decides how many serves can be made, and what runs out first", () => {
  const data = homeBar();
  const lastWord = cocktailOf(data, "last-word");
  assert.deepEqual(makeable(data, lastWord), { count: Infinity, limiting: [] });

  data.bar.stock.gin = { counts: { "gin-700": 1 } };
  data.bar.stock.chartreuse = { loose: 180 };
  assert.deepEqual(makeable(data, lastWord), { count: 8, limiting: ["chartreuse"] });

  // Exactly enough is enough.
  data.bar.stock.chartreuse = { loose: 67.5 };
  data.bar.stock.maraschino = { loose: 67.5 };
  assert.deepEqual(makeable(data, lastWord), { count: 3, limiting: ["chartreuse", "maraschino"] });

  data.bar.stock.maraschino = {};
  assert.deepEqual(makeable(data, lastWord), { count: 0, limiting: ["maraschino"] });
});
