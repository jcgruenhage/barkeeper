import { test } from "node:test";
import assert from "node:assert/strict";
import { foldSizeIntoLoose, stockAmount } from "../src/bar.js";

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
