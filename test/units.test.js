import { test } from "node:test";
import assert from "node:assert/strict";
import { conversionFactor, ingredientUnits, standardUnits } from "../src/units.js";

const table = [["oz", "ml", 29.57], ["ml", "cl", 0.1]];
const gin = { baseUnit: "ml", units: [["bottle", 700], ["oz", 30]] };

test("standard units apply in both directions", () => {
  assert.deepEqual(standardUnits(gin, table), [["oz", 29.57], ["cl", 10]]);
  assert.deepEqual(standardUnits({ baseUnit: "g" }, table), []);
});

test("a standard conversion wins over the ingredient's own", () => {
  assert.deepEqual(ingredientUnits(gin, table), [["bottle", 700], ["oz", 29.57], ["cl", 10]]);
  assert.equal(ingredientUnits(gin, table, false).length, 4);
});

test("amounts convert to the base unit", () => {
  assert.equal(conversionFactor(gin, "ml", table), 1);
  assert.equal(conversionFactor(gin, "bottle", table), 700);
  assert.equal(conversionFactor(gin, "cl", table), 10);
  // Unknown units count as the base unit.
  assert.equal(conversionFactor(gin, "dash", table), 1);
});
