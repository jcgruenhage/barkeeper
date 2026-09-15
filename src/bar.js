// A permanent bar: its stock, what it can make from it, and what to buy.
//
// Stock is set, not counted down: someone looks at the shelf and writes down
// how much there is. An ingredient's stock entry holds counts of its sizes
// ("2.4 bottles of 700 ml") and a loose amount in its base unit, for what is
// not in a size, like a batch of syrup. An ingredient without an entry is not
// tracked and never runs out; an entry that adds up to zero means it is out.

import { conversionFactor } from "./units.js";

/** How much of an ingredient is in stock, or undefined if it is not tracked. */
export function stockAmount(ingredient, entry) {
  if (!entry) return undefined;
  let amount = finite(entry.loose);
  for (const [sizeId, count] of Object.entries(entry.counts ?? {})) {
    // Counts of a size that was removed at the same time are ignored.
    const size = ingredient?.sizes?.find((s) => s.id === sizeId);
    if (size) amount += finite(count) * finite(size.size);
  }
  return amount;
}

/**
 * Remove a size from a stock entry, keeping its amount as loose stock.
 * Mutates `entry`.
 */
export function foldSizeIntoLoose(entry, size) {
  const count = entry?.counts?.[size.id];
  if (count === undefined) return;
  entry.loose = finite(entry.loose) + finite(count) * finite(size.size);
  delete entry.counts[size.id];
}

/** Look up stock by ingredient id in barkeeper data. */
export function stockOf(data) {
  const ingredients = new Map((data.ingredients ?? []).map((i) => [i.id, i]));
  return (id) => stockAmount(ingredients.get(id), data.bar?.stock?.[id]);
}

/**
 * What one serve of a cocktail (ingredients and garnishes) takes from stock,
 * as a map from ingredient id to an amount in its base unit, including each
 * ingredient's safety factor. Sub-recipes are broken down into their
 * ingredients, except those for which `stop(id)` is true, which are taken
 * from stock as they are.
 */
export function serveNeeds(data, cocktail, stop = () => false) {
  const ingredients = new Map((data.ingredients ?? []).map((i) => [i.id, i]));
  const table = data.settings?.unitConvTable ?? [];
  const needs = new Map();

  const add = (entry, scale, visiting) => {
    const ingredient = ingredients.get(entry.id);
    if (!ingredient) return;
    const amount =
      finite(entry.amount) * scale *
      conversionFactor(ingredient, entry.unit, table) *
      (1 + finite(ingredient.safetyFactor));
    const recipe = ingredient.ingredients ?? [];
    const breakDown =
      recipe.length > 0 && finite(ingredient.yield) > 0 &&
      !stop(ingredient.id) && !visiting.has(ingredient.id);
    if (breakDown) {
      visiting.add(ingredient.id);
      for (const sub of recipe) add(sub, amount / finite(ingredient.yield), visiting);
      visiting.delete(ingredient.id);
    } else {
      needs.set(ingredient.id, (needs.get(ingredient.id) ?? 0) + amount);
    }
  };

  for (const entry of [...(cocktail.ingredients ?? []), ...(cocktail.garnishes ?? [])]) {
    add(entry, 1, new Set());
  }
  return needs;
}

/**
 * How many serves of a cocktail the stock allows, making nothing else, and
 * the ingredients that run out first. Infinity if none of its ingredients
 * are tracked. Sub-recipes with stock are used as they are; the others are
 * broken down into their ingredients.
 */
export function makeable(data, cocktail) {
  const stock = stockOf(data);
  const needs = serveNeeds(data, cocktail, (id) => stock(id) !== undefined);
  let count = Infinity;
  let limiting = [];
  for (const [id, need] of needs) {
    const amount = stock(id);
    if (amount === undefined || !(need > 0)) continue;
    // Rounding errors must not turn 3 serves into 2.999.
    const serves = Math.floor(amount / need + 1e-9);
    if (serves < count) {
      count = serves;
      limiting = [id];
    } else if (serves === count) {
      limiting.push(id);
    }
  }
  return { count, limiting };
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
