// A permanent bar: its stock, what it can make from it, and what to buy.
//
// Stock is set, not counted down: someone looks at the shelf and writes down
// how much there is. An ingredient's stock entry holds counts of its sizes
// ("2.4 bottles of 700 ml") and a loose amount in its base unit, for what is
// not in a size, like a batch of syrup. An ingredient without an entry is not
// tracked and never runs out; an entry that adds up to zero means it is out.

import { cheapestOption } from "./sizes.js";
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
  const entries = [...(cocktail.ingredients ?? []), ...(cocktail.garnishes ?? [])];
  return recipeNeeds(data, entries, 1, stop);
}

// What `scale` times the recipe `entries` takes, broken down like serveNeeds().
function recipeNeeds(data, entries, scale, stop) {
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

  for (const entry of entries) add(entry, scale, new Set());
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

/**
 * What to buy, and which sub-recipes to make, to restock a permanent bar.
 *
 * Each cocktail on the menu has two targets: `solo`, how many serves the stock
 * should allow if nothing else is made, and `guaranteed`, how many it should
 * allow while every other cocktail on the menu is made up to its guaranteed
 * number too. For each ingredient, the stock should cover the most of:
 *
 * - the guaranteed numbers of all cocktails together,
 * - the solo number of any one cocktail,
 * - its minimum stock.
 *
 * Only tracked ingredients are restocked. A tracked sub-recipe that falls
 * short is made, and what making it takes is added to its ingredients.
 * Every ingredient is bought in whole units of its cheapest option for the
 * amount missing.
 *
 * Returns `buy`, one entry per ingredient to buy (`option` is undefined if it
 * has no source), and `make`, one entry per sub-recipe to make, both in the
 * base unit of the ingredient.
 */
export function restock(data) {
  const ingredients = new Map((data.ingredients ?? []).map((i) => [i.id, i]));
  const stock = stockOf(data);
  const tracked = (id) => stock(id) !== undefined;

  const target = new Map();
  const raise = (id, amount) => target.set(id, Math.max(target.get(id) ?? 0, amount));

  const guaranteed = new Map();
  for (const cocktail of data.cocktails ?? []) {
    const entry = data.bar?.cocktails?.[cocktail.id];
    if (entry?.onMenu !== true) continue;
    const guaranteedServes = Math.max(0, finite(entry.guaranteed));
    const soloServes = Math.max(finite(entry.solo), guaranteedServes);
    if (soloServes === 0) continue;
    for (const [id, need] of serveNeeds(data, cocktail, tracked)) {
      guaranteed.set(id, (guaranteed.get(id) ?? 0) + guaranteedServes * need);
      raise(id, soloServes * need);
    }
  }
  for (const [id, amount] of guaranteed) raise(id, amount);
  for (const [id, amount] of Object.entries(data.bar?.par ?? {})) raise(id, finite(amount));

  const buy = [];
  const make = [];
  // Sub-recipes before what they are made of, so that making one adds to
  // its ingredients before they are looked at.
  for (const id of recipeOrder(ingredients)) {
    const ingredient = ingredients.get(id);
    const inStock = stock(id);
    if (inStock === undefined || !target.has(id)) continue;
    const missing = target.get(id) - inStock;
    if (!(missing > 1e-9)) continue;

    const recipe = ingredient.ingredients ?? [];
    if (recipe.length > 0 && finite(ingredient.yield) > 0) {
      make.push({ id, target: target.get(id), stock: inStock, amount: missing });
      const needs = recipeNeeds(data, recipe, missing / finite(ingredient.yield), tracked);
      for (const [sub, amount] of needs) target.set(sub, (target.get(sub) ?? 0) + amount);
      continue;
    }

    const option = cheapestOption(ingredient, missing);
    const num = option ? Math.ceil(missing / option.size - 1e-9) : 0;
    buy.push({
      id,
      target: target.get(id),
      stock: inStock,
      missing,
      option,
      num,
      cost: option ? num * option.price : 0,
    });
  }
  return { buy, make };
}

// Every ingredient id, each sub-recipe before the ingredients of its recipe.
function recipeOrder(ingredients) {
  const order = [];
  const seen = new Set();
  const visit = (id) => {
    if (seen.has(id) || !ingredients.has(id)) return;
    seen.add(id);
    for (const sub of ingredients.get(id).ingredients ?? []) visit(sub.id);
    order.push(id);
  };
  for (const id of ingredients.keys()) visit(id);
  return order.reverse();
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
