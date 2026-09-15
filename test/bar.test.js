import { test } from "node:test";
import assert from "node:assert/strict";
import { foldSizeIntoLoose, makeable, restock, serveNeeds, stockAmount } from "../src/bar.js";

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
  const bottle = (id, size) => ({ id, size, sources: [{ id: `${id}-shop`, price: 20, shopLink: "" }] });
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

function onMenu(data, id, solo, guaranteed) {
  data.bar.cocktails[id] = { onMenu: true, solo, guaranteed };
}

function shopping(result) {
  return Object.fromEntries(result.buy.map((item) => [item.id, [Math.round(item.missing * 1000) / 1000, item.num]]));
}

test("shared ingredients are bought for the larger of solo and all guarantees", () => {
  const data = homeBar();
  for (const id of ["gin", "mezcal", "chartreuse", "maraschino", "lime"]) data.bar.stock[id] = {};
  onMenu(data, "last-word", 10, 5);
  onMenu(data, "closing-argument", 10, 5);
  // 10 Last Words or 10 Closing Arguments or 5 of each: 225 ml of each.
  assert.deepEqual(shopping(restock(data)), {
    gin: [225, 1], mezcal: [225, 1], chartreuse: [225, 1], maraschino: [225, 1], lime: [225, 0],
  });

  // A third cocktail with chartreuse: the guarantees need 15 serves of it.
  data.cocktails.push({ id: "bijou", ingredients: [{ id: "gin", unit: "ml", amount: 22.5 }, { id: "chartreuse", unit: "ml", amount: 22.5 }], garnishes: [] });
  onMenu(data, "bijou", 5, 5);
  const result = shopping(restock(data));
  assert.equal(result.chartreuse[0], 337.5);
  // Gin: solo 10 Last Words is 225, guarantees are 5 Last Words and 5 Bijous.
  assert.equal(result.gin[0], 225);
});

test("stock, minimums, the menu and the solo floor all count", () => {
  const data = homeBar();
  data.bar.stock.gin = { counts: { "gin-700": 0.1 } };
  data.bar.stock.chartreuse = { loose: 500 };
  data.bar.stock.maraschino = {};
  onMenu(data, "last-word", 2, 8);
  // Not on the menu: ignored.
  data.bar.cocktails["closing-argument"] = { onMenu: false, solo: 50, guaranteed: 50 };
  data.bar.par.maraschino = 700;
  // Minimum of an untracked ingredient: nothing to compare it with.
  data.bar.par.mezcal = 700;

  const { buy, make } = restock(data);
  assert.deepEqual(make, []);
  // Solo is at least the guaranteed number: 8 serves of 22.5 ml.
  const gin = buy.find((b) => b.id === "gin");
  assert.deepEqual([gin.target, gin.stock, Math.round(gin.missing * 1000) / 1000, gin.num, gin.cost], [180, 70, 110, 1, 20]);
  assert.equal(gin.option.sizeId, "gin-700");
  // Enough chartreuse; lime is not tracked; the maraschino minimum wins.
  assert.deepEqual(shopping({ buy }), { gin: [110, 1], maraschino: [700, 1] });
});

test("a short sub-recipe is made from its ingredients", () => {
  const data = homeBar();
  data.ingredients.push(
    { id: "honey-syrup", ingredients: [{ id: "honey", unit: "ml", amount: 300 }, { id: "water", unit: "ml", amount: 250 }], yield: 500, safetyFactor: 0, baseUnit: "ml" },
    { id: "honey", ingredients: [], safetyFactor: 0, baseUnit: "ml", sizes: [{ id: "jar", size: 250, sources: [{ id: "shop", price: 6 }] }] },
    { id: "water", ingredients: [], safetyFactor: 0, baseUnit: "ml" },
  );
  data.cocktails.push({ id: "bees-knees", ingredients: [{ id: "gin", unit: "ml", amount: 60 }, { id: "honey-syrup", unit: "ml", amount: 20 }], garnishes: [] });
  onMenu(data, "bees-knees", 10, 0);
  data.bar.stock["honey-syrup"] = { loose: 50 };
  data.bar.stock.honey = { loose: 10 };
  data.bar.par.honey = 100;

  const { buy, make } = restock(data);
  // 200 ml of syrup for 10 serves, 50 in stock.
  assert.deepEqual(make, [{ id: "honey-syrup", target: 200, stock: 50, amount: 150 }]);
  // 150 ml of syrup takes 90 ml of honey, on top of the minimum of 100.
  const honey = buy.find((b) => b.id === "honey");
  assert.deepEqual([honey.target, honey.missing, honey.num, honey.cost], [190, 180, 1, 6]);
  // Gin and water are not tracked.
  assert.deepEqual(buy.map((b) => b.id), ["honey"]);
});

test("an ingredient without a source is still listed", () => {
  const data = homeBar();
  data.bar.stock.lime = {};
  onMenu(data, "last-word", 4, 0);
  const [lime] = restock(data).buy;
  assert.deepEqual([lime.id, lime.missing, lime.option, lime.num, lime.cost], ["lime", 90, undefined, 0, 0]);
});
