// Copying records from one space into another.
//
// A copy keeps its UUID, so a record is the same record in every space it was
// copied to, and a target "already has" a record exactly when it has one with
// that id. Everything a record needs comes along if the target does not have
// it yet: for a cocktail its ingredients, their sub-recipes, the prep method
// and the glass; for an ingredient its sub-recipes, recursively. Records the
// target already has are left as they are.

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function has(list, id) {
  return (list ?? []).some((record) => record.id === id);
}

function copyIngredients(source, target, rows) {
  for (const row of rows ?? []) {
    if (row.id === undefined || has(target.ingredients, row.id)) continue;
    const ingredient = source.ingredients?.find((i) => i.id === row.id);
    if (!ingredient) continue;
    target.ingredients.unshift(clone(ingredient));
    copyIngredients(source, target, ingredient.ingredients);
  }
}

function copyById(list, targetList, id) {
  if (id === undefined || id === null || id === "" || has(targetList, id)) return;
  const record = list?.find((r) => r.id === id);
  if (record) targetList.push(clone(record));
}

function prepare(target) {
  target.cocktails ??= [];
  target.ingredients ??= [];
  target.prepMethods ??= [];
  target.glassTypes ??= [];
}

/**
 * Copy the cocktail `cocktailId` from `source` (barkeeper data) into `target`
 * (barkeeper data, mutated in place). Returns whether it was copied, which it
 * is not if the target already has it.
 */
export function copyCocktailInto(source, cocktailId, target) {
  const cocktail = source.cocktails?.find((c) => c.id === cocktailId);
  if (!cocktail) throw new Error("Cocktail not found");
  prepare(target);
  if (has(target.cocktails, cocktailId)) return { copied: false };

  const copy = clone(cocktail);
  if (!has(target.events, cocktail.event)) copy.event = "null";
  copyIngredients(source, target, cocktail.ingredients);
  copyIngredients(source, target, cocktail.garnishes);
  copyById(source.prepMethods, target.prepMethods, cocktail.method);
  copyById(source.glassTypes, target.glassTypes, cocktail.glass);
  target.cocktails.unshift(copy);
  return { copied: true };
}

/**
 * Copy the ingredient `ingredientId` from `source` into `target`, along with
 * everything its recipe lists, recursively. Returns whether it was copied.
 */
export function copyIngredientInto(source, ingredientId, target) {
  if (!has(source.ingredients, ingredientId)) throw new Error("Ingredient not found");
  prepare(target);
  if (has(target.ingredients, ingredientId)) return { copied: false };
  copyIngredients(source, target, [{ id: ingredientId }]);
  return { copied: true };
}
