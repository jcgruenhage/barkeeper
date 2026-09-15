import { test } from "node:test";
import assert from "node:assert/strict";
import { applyImport, parseImport, planImport, reviewNeeded } from "../src/import.js";

// A space in the shape the app really produces, quirks included: glasses with
// small integer ids from before glasses had UUIDs, two of them called the same
// thing, and lime measured in oz of juice per fruit.
function space() {
  return {
    cocktails: [
      {
        id: "32221c97-b81a-4d0c-8649-b1b06bd8d58d",
        name: "Bramble",
        event: "null",
        ingredients: [{ id: "gin", unit: "oz", amount: 1.5 }],
        garnishes: [],
      },
    ],
    ingredients: [
      { id: "gin", name: "Gin", baseUnit: "ml", abv: 45, units: [], ingredients: [], sizes: [] },
      { id: "chartreuse", name: "Green Chartreuse", baseUnit: "ml", abv: 55, units: [], ingredients: [], sizes: [] },
      { id: "lime", name: "Lime", baseUnit: "pcs", abv: 0, units: [["ml", 0.033], ["oz", 1]], ingredients: [], sizes: [] },
      { id: "simple", name: "Simple", baseUnit: "ml", abv: 0, units: [], ingredients: [], sizes: [], yield: 200 },
    ],
    prepMethods: [
      { id: "m-stirred", name: "stirred" },
      { id: "m-shaken", name: "shaken" },
      { id: "m-double", name: "shaken, double strained" },
    ],
    glassTypes: [
      { id: "g-tumbler", name: "Tumbler", volume: 0 },
      { id: 2, name: "Tumbler", volume: 300 },
      { id: 1, name: "Coupe", volume: 200 },
    ],
    events: [{ id: "e1", name: "29. Geburtstag" }],
    bar: { cocktails: {}, stock: {} },
    settings: { mode: "bar", unitConvTable: [["oz", "ml", 30], ["dashes", "ml", 0.15]] },
  };
}

function counter(prefix = "new") {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

const entry = (entries, name) => entries.find((e) => e.name === name);
const names = (list) => list.map((r) => r.name);
const cocktail = (data, name) => data.cocktails.find((c) => c.name === name);
const ingredientNamed = (data, name) => data.ingredients.find((i) => i.name === name);

test("matches ingredients the space already has instead of duplicating them", () => {
  const target = space();
  const file = {
    cocktails: [
      {
        name: "Last Word",
        method: "shaken",
        glass: "Coupe",
        ingredients: [
          { name: "Gin", amount: 1, unit: "oz" },
          { name: "Maraschino", amount: 1, unit: "oz" },
          { name: "Green Chartreuse", amount: 1, unit: "oz" },
          { name: "Lime", amount: 1, unit: "oz" },
        ],
      },
    ],
  };

  const plan = planImport(file, target);
  assert.equal(entry(plan.ingredients, "Gin").decision, "match");
  assert.equal(entry(plan.ingredients, "Gin").targetId, "gin");
  assert.equal(entry(plan.ingredients, "Green Chartreuse").decision, "match");
  assert.equal(entry(plan.ingredients, "Maraschino").decision, "create");

  const result = applyImport(target, plan, { newId: counter() });
  assert.equal(target.ingredients.length, 5);
  assert.deepEqual(names(target.ingredients).sort(), ["Gin", "Green Chartreuse", "Lime", "Maraschino", "Simple"]);
  assert.equal(result.counts.ingredients.create, 1);
  assert.equal(result.counts.ingredients.match, 3);

  const added = cocktail(target, "Last Word");
  assert.deepEqual(
    added.ingredients.map((row) => row.id),
    ["gin", ingredientNamed(target, "Maraschino").id, "chartreuse", "lime"],
  );
  assert.deepEqual(added.ingredients.map((row) => [row.amount, row.unit]), [[1, "oz"], [1, "oz"], [1, "oz"], [1, "oz"]]);
});

test("matches by name whatever the case, spacing and accents", () => {
  const target = space();
  const file = { cocktails: [{ name: "X", ingredients: [{ name: "  gréen   CHARTREUSE ", amount: 1, unit: "oz" }] }] };
  const plan = planImport(file, target);
  const resolved = plan.ingredients[0];
  assert.equal(resolved.decision, "match");
  assert.equal(resolved.targetId, "chartreuse");
  // Under the space's spelling: a match is not a rename.
  assert.equal(resolved.name, "Green Chartreuse");
  assert.equal(resolved.incomingName, "gréen   CHARTREUSE");
});

test("matches by id even when the file calls it something else", () => {
  const target = space();
  const file = { ingredients: [{ id: "gin", name: "London Dry" }], cocktails: [{ name: "X", ingredients: [{ id: "gin", amount: 1, unit: "oz" }] }] };
  const plan = planImport(file, target);
  assert.equal(plan.ingredients.length, 1);
  assert.equal(plan.ingredients[0].matchedBy, "id");
  assert.equal(plan.ingredients[0].name, "Gin");
  applyImport(target, plan, { newId: counter() });
  assert.equal(target.ingredients.length, 4);
  assert.equal(ingredientNamed(target, "London Dry"), undefined);
});

test("mentions of the same ingredient across cocktails become one record", () => {
  const target = space();
  const file = {
    cocktails: [
      { name: "A", ingredients: [{ name: "Maraschino", amount: 1, unit: "oz" }] },
      { name: "B", ingredients: [{ name: "maraschino", amount: 0.5, unit: "oz" }] },
    ],
  };
  const plan = planImport(file, target);
  assert.equal(plan.ingredients.length, 1);
  assert.deepEqual(plan.ingredients[0].usedBy, ["A", "B"]);

  applyImport(target, plan, { newId: counter() });
  assert.equal(target.ingredients.filter((i) => i.name === "Maraschino").length, 1);
  const id = ingredientNamed(target, "Maraschino").id;
  assert.equal(cocktail(target, "A").ingredients[0].id, id);
  assert.equal(cocktail(target, "B").ingredients[0].id, id);
});

test("a new ingredient gets the shape the app gives one, plus what the file says", () => {
  const target = space();
  const file = { ingredients: [{ name: "Orgeat", abv: 0, baseUnit: "ml", notes: "almond", sizes: [{ size: 500, sources: [{ price: 12.5, shopLink: "https://example.org" }] }] }] };
  const plan = planImport(file, target);
  applyImport(target, plan, { newId: counter() });

  const orgeat = ingredientNamed(target, "Orgeat");
  assert.equal(orgeat.id, "new-1");
  assert.equal(orgeat.baseUnit, "ml");
  assert.equal(orgeat.notes, "almond");
  assert.equal(orgeat.safetyFactor, 0.1);
  assert.equal(orgeat.color, "#e9ecef");
  assert.deepEqual(orgeat.allergens, []);
  assert.equal(orgeat.hideInShoppingList, false);
  assert.equal(orgeat.sizes[0].size, 500);
  assert.equal(orgeat.sizes[0].sources[0].price, 12.5);
  // Sizes and sources are records too, so they need ids of their own.
  assert.equal(typeof orgeat.sizes[0].id, "string");
  assert.equal(typeof orgeat.sizes[0].sources[0].id, "string");
});

test("resolves sub-recipes, however deep, and whatever order they are listed in", () => {
  const target = space();
  const file = {
    ingredients: [
      { name: "Sherbet", ingredients: [{ name: "Oleo", amount: 100, unit: "ml" }, { name: "Lime", amount: 2, unit: "oz" }] },
      { name: "Oleo", ingredients: [{ name: "Sugar", amount: 200, unit: "g" }] },
    ],
    cocktails: [{ name: "X", ingredients: [{ name: "Sherbet", amount: 1, unit: "oz" }] }],
  };
  const plan = planImport(file, target);
  assert.deepEqual(names(plan.ingredients).sort(), ["Lime", "Oleo", "Sherbet", "Sugar"]);

  applyImport(target, plan, { newId: counter() });
  const sherbet = ingredientNamed(target, "Sherbet");
  const oleo = ingredientNamed(target, "Oleo");
  assert.deepEqual(sherbet.ingredients.map((r) => r.id), [oleo.id, "lime"]);
  assert.deepEqual(oleo.ingredients.map((r) => r.id), [ingredientNamed(target, "Sugar").id]);
});

test("resolves prep methods and glasses by name, and legacy numeric ids", () => {
  const target = space();
  const file = {
    cocktails: [
      { name: "A", method: "shaken", glass: "Coupe" },
      { name: "B", method: "shaken, double strained", glass: 2 },
      { name: "C", method: "rolled", glass: "Nick & Nora" },
    ],
  };
  const plan = planImport(file, target);
  assert.equal(entry(plan.prepMethods, "shaken").targetId, "m-shaken");
  assert.equal(entry(plan.prepMethods, "shaken, double strained").targetId, "m-double");
  assert.equal(entry(plan.prepMethods, "rolled").decision, "create");

  applyImport(target, plan, { newId: counter() });
  assert.equal(cocktail(target, "A").method, "m-shaken");
  assert.equal(cocktail(target, "A").glass, 1);
  assert.equal(cocktail(target, "B").method, "m-double");
  assert.equal(cocktail(target, "B").glass, 2);
  assert.equal(cocktail(target, "C").method, target.prepMethods.find((m) => m.name === "rolled").id);
  assert.equal(cocktail(target, "C").glass, target.glassTypes.find((g) => g.name === "Nick & Nora").id);
  // A created glass keeps the app's default shape.
  assert.equal(target.glassTypes.find((g) => g.name === "Nick & Nora").volume, 0);
});

test("two records of one name in the space are matched but flagged for review", () => {
  const target = space();
  const plan = planImport({ cocktails: [{ name: "A", glass: "Tumbler" }] }, target);
  const tumbler = plan.glassTypes[0];
  assert.equal(tumbler.decision, "match");
  assert.equal(tumbler.ambiguous, true);
  assert.equal(tumbler.needsReview, true);
  // The other one is offered, so the choice can be corrected.
  assert.deepEqual(tumbler.candidates.map((c) => c.id), [2]);
  assert.ok(reviewNeeded(plan).includes(tumbler));

  tumbler.targetId = 2;
  applyImport(target, plan, { newId: counter() });
  assert.equal(cocktail(target, "A").glass, 2);
  assert.equal(target.glassTypes.length, 3);
});

test("a name that only resembles an existing one is suggested, never matched", () => {
  const target = space();
  const plan = planImport({ cocktails: [{ name: "X", ingredients: [{ name: "Lime juice", amount: 1, unit: "oz" }] }] }, target);
  const lime = plan.ingredients[0];
  assert.equal(lime.decision, "create");
  assert.equal(lime.matchedBy, null);
  assert.equal(lime.needsReview, true);
  assert.deepEqual(lime.candidates.map((c) => c.name), ["Lime"]);

  // Taking the suggestion is all the review screen has to do.
  lime.decision = "match";
  lime.targetId = "lime";
  applyImport(target, plan, { newId: counter() });
  assert.equal(target.ingredients.length, 4);
  assert.equal(cocktail(target, "X").ingredients[0].id, "lime");
});

test("a cocktail the space already has is skipped by default, and can be imported anyway", () => {
  const target = space();
  const plan = planImport({ cocktails: [{ name: "Bramble", ingredients: [{ name: "Gin", amount: 2, unit: "oz" }] }] }, target);
  assert.equal(plan.cocktails[0].decision, "skip");
  assert.equal(plan.cocktails[0].needsReview, true);

  applyImport(target, plan, { newId: counter() });
  assert.equal(target.cocktails.length, 1);
  assert.equal(target.cocktails[0].ingredients[0].amount, 1.5);

  const second = planImport({ cocktails: [{ name: "Bramble", ingredients: [{ name: "Gin", amount: 2, unit: "oz" }] }] }, target);
  second.cocktails[0].decision = "create";
  applyImport(target, second, { newId: counter("dup") });
  assert.equal(target.cocktails.length, 2);
});

test("skipping an ingredient leaves it out of the recipes and says so", () => {
  const target = space();
  const plan = planImport(
    { cocktails: [{ name: "X", ingredients: [{ name: "Gin", amount: 1, unit: "oz" }, { name: "Mystery", amount: 1, unit: "oz" }] }] },
    target,
  );
  entry(plan.ingredients, "Mystery").decision = "skip";
  const result = applyImport(target, plan, { newId: counter() });

  assert.deepEqual(cocktail(target, "X").ingredients.map((r) => r.id), ["gin"]);
  assert.equal(ingredientNamed(target, "Mystery"), undefined);
  assert.match(result.warnings.join("\n"), /"Mystery" was left out/);
});

test("warns about units the space cannot convert, and only those", () => {
  const target = space();
  const plan = planImport(
    {
      cocktails: [
        {
          name: "X",
          ingredients: [
            { name: "Gin", amount: 1, unit: "oz" },
            { name: "Lime", amount: 0.5, unit: "pcs" },
            { name: "Raw cane sugar", amount: 1, unit: "tbsp" },
          ],
        },
      ],
    },
    target,
  );
  const result = applyImport(target, plan, { newId: counter() });
  const warnings = result.warnings.join("\n");
  assert.match(warnings, /no conversion for "tbsp"/);
  assert.doesNotMatch(warnings, /"oz"/);
  assert.doesNotMatch(warnings, /"pcs"/);
});

test("files cocktails under the chosen event, and onto the menu when asked", () => {
  const target = space();
  const plan = planImport({ cocktails: [{ name: "A" }, { name: "B" }] }, target);
  const result = applyImport(target, plan, { event: "e1", onMenu: true, newId: counter() });
  assert.equal(cocktail(target, "A").event, "e1");
  assert.equal(target.bar.cocktails[cocktail(target, "A").id].onMenu, true);
  assert.deepEqual(result.cocktails.map((c) => c.name), ["A", "B"]);
});

test("keeps the file's own uuids, so importing the same file twice changes nothing", () => {
  const target = space();
  const file = {
    ingredients: [{ id: "0cd0ad3c-1b6c-45f6-9d4b-3b2a2f0e4d11", name: "Orgeat" }],
    cocktails: [
      {
        id: "7b0f6a4e-2c3d-4f5a-8b9c-0d1e2f3a4b5c",
        name: "Mai Tai",
        ingredients: [{ id: "0cd0ad3c-1b6c-45f6-9d4b-3b2a2f0e4d11", amount: 0.5, unit: "oz" }],
      },
    ],
  };
  applyImport(target, planImport(file, target), { newId: counter() });
  assert.equal(ingredientNamed(target, "Orgeat").id, "0cd0ad3c-1b6c-45f6-9d4b-3b2a2f0e4d11");
  assert.equal(cocktail(target, "Mai Tai").id, "7b0f6a4e-2c3d-4f5a-8b9c-0d1e2f3a4b5c");

  const again = planImport(file, target);
  assert.equal(again.ingredients[0].matchedBy, "id");
  assert.equal(again.cocktails[0].decision, "skip");
  applyImport(target, again, { newId: counter("second") });
  assert.equal(target.cocktails.length, 2);
  assert.equal(target.ingredients.length, 5);
});

test("notes a file that lists the same thing twice", () => {
  const target = space();
  const plan = planImport({ ingredients: [{ name: "Orgeat" }, { name: "orgeat" }] }, target);
  assert.equal(plan.ingredients.length, 1);
  assert.match(plan.problems.join("\n"), /more than one ingredient called "orgeat"/);
});

test("carries over the parts of a cocktail that are not references", () => {
  const target = space();
  const file = {
    cocktails: [
      { name: "A", notes: "two lines\nof note", price: 7, flavorCues: ["bright", "funky"], cubes: 4, crushed: 0, numToPrep: 12 },
    ],
  };
  applyImport(target, planImport(file, target), { newId: counter() });
  const added = cocktail(target, "A");
  assert.equal(added.notes, "two lines\nof note");
  assert.equal(added.price, 7);
  assert.deepEqual(added.flavorCues, ["bright", "funky"]);
  assert.equal(added.cubes, 4);
  assert.equal(added.numToPrep, 12);
  // Untouched by the file, so the app's defaults stand.
  assert.equal(added.largeCubes, 0);
  assert.equal(added.event, "null");
});

test("does not change the file it was given", () => {
  const target = space();
  const file = { cocktails: [{ name: "A", ingredients: [{ name: "Gin", amount: 1, unit: "oz" }] }] };
  const before = JSON.stringify(file);
  applyImport(target, planImport(file, target), { newId: counter() });
  assert.equal(JSON.stringify(file), before);
});

test("leaves records the space already has exactly as they were", () => {
  const target = space();
  const before = JSON.stringify(target.ingredients.find((i) => i.id === "gin"));
  const file = { ingredients: [{ name: "Gin", abv: 40, notes: "overwrite me", sizes: [{ size: 1000, sources: [] }] }] };
  applyImport(target, planImport(file, target), { newId: counter() });
  assert.equal(JSON.stringify(target.ingredients.find((i) => i.id === "gin")), before);
});

test("reads an import file, and refuses what it cannot use", () => {
  assert.deepEqual(parseImport('{"cocktails":[{"name":"A"}]}').cocktails, [{ name: "A" }]);
  assert.throws(() => parseImport("not json"), /not a JSON file/);
  assert.throws(() => parseImport("[]"), /has to be a JSON object/);
  assert.throws(() => parseImport("{}"), /no cocktails or ingredients/);
  assert.throws(() => parseImport('{"barkeeperImport":99,"cocktails":[{"name":"A"}]}'), /newer barkeeper/);
});
