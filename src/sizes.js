// Ingredients are bought in sizes (a 700 ml bottle, a 1 l bottle), and each
// size lists the sources that sell it and at what price.

/** Every way to buy an ingredient: one entry per source of each size. */
export function purchaseOptions(ingredient) {
  return (ingredient?.sizes ?? []).flatMap((size) =>
    (size.sources ?? []).map((source) => ({
      sizeId: size.id,
      sourceId: source.id,
      size: size.size,
      price: source.price,
      shopLink: source.shopLink,
    })),
  );
}

/**
 * The cheapest way to buy at least `amount` of an ingredient, in whole units
 * of one size. Ties go to the option listed first. Undefined if the
 * ingredient cannot be bought.
 */
export function cheapestOption(ingredient, amount) {
  const cost = (option) => Math.ceil(amount / option.size) * option.price;
  let best;
  for (const option of purchaseOptions(ingredient)) {
    if (!(option.size > 0)) continue;
    if (best === undefined || cost(option) < cost(best)) best = option;
  }
  return best;
}
