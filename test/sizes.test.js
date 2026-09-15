import { test } from "node:test";
import assert from "node:assert/strict";
import { cheapestOption, purchaseOptions, unitPrice } from "../src/sizes.js";

const gin = {
  id: "gin",
  sizes: [
    {
      id: "s700",
      size: 700,
      sources: [
        { id: "a", price: 20, shopLink: "shop a" },
        { id: "b", price: 18, shopLink: "shop b" },
      ],
    },
    { id: "s1000", size: 1000, sources: [{ id: "c", price: 24, shopLink: "shop c" }] },
    { id: "s0", size: 0, sources: [{ id: "d", price: 1, shopLink: "typo" }] },
  ],
};

test("purchase options list every source of every size", () => {
  assert.deepEqual(
    purchaseOptions(gin).map((o) => [o.sizeId, o.sourceId, o.size, o.price, o.shopLink]),
    [
      ["s700", "a", 700, 20, "shop a"],
      ["s700", "b", 700, 18, "shop b"],
      ["s1000", "c", 1000, 24, "shop c"],
      ["s0", "d", 0, 1, "typo"],
    ],
  );
  assert.deepEqual(purchaseOptions({ id: "syrup", ingredients: [] }), []);
  assert.deepEqual(purchaseOptions(undefined), []);
});

test("the cheapest option depends on how much is needed", () => {
  // 700 ml: one 700 ml bottle at 18 beats one litre at 24.
  assert.equal(cheapestOption(gin, 700).sourceId, "b");
  // 1000 ml: two 700 ml bottles cost 36, one litre 24.
  assert.equal(cheapestOption(gin, 1000).sourceId, "c");
  // Sizes of zero are skipped rather than dividing by zero.
  assert.equal(cheapestOption({ sizes: [gin.sizes[2]] }, 100), undefined);
  assert.equal(cheapestOption({ sizes: [] }, 100), undefined);
});

test("the unit price is the lowest over all sizes and sources", () => {
  // 18/700 is about 0.0257, 24/1000 is 0.024.
  assert.equal(unitPrice(gin), 0.024);
  assert.equal(unitPrice({ sizes: [gin.sizes[2]] }), undefined);
  assert.equal(unitPrice({ id: "syrup", ingredients: [] }), undefined);
});
