// Copying records from one space into another.
//
// Spaces never reference each other: a copy gets new ids and a `copiedFrom`
// note ({ space, id, heads }) pointing at where it came from. Everything the
// cocktail needs comes along (ingredients and their sub-recipes, the prep
// method, the glass), unless the target space already has it, either because
// it was copied from the same record before, or because it has the same id and
// name (both spaces came from the same import), or the same name.

function sameName(a, b) {
  const x = String(a ?? "").trim().toLowerCase();
  return x !== "" && x === String(b ?? "").trim().toLowerCase();
}

function findExisting(list, record, space) {
  return (
    list.find((t) => t.copiedFrom?.space === space && t.copiedFrom?.id === record.id) ??
    list.find((t) => t.id === record.id && sameName(t.name, record.name)) ??
    list.find((t) => sameName(t.name, record.name))
  );
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Copy the cocktail `cocktailId` from `source` (barkeeper data) into `target`
 * (barkeeper data, mutated in place). Returns the id of the new cocktail.
 */
export function copyCocktailInto(source, cocktailId, target, { space, heads = [] }) {
  const cocktail = source.cocktails?.find((c) => c.id === cocktailId);
  if (!cocktail) throw new Error("Cocktail not found");

  target.cocktails ??= [];
  target.ingredients ??= [];
  target.prepMethods ??= [];
  target.glassTypes ??= [];

  const provenance = (id) => ({ space, id, heads: [...heads] });
  const ingredientIds = new Map();

  const ingredientId = (id) => {
    if (ingredientIds.has(id)) return ingredientIds.get(id);
    const ingredient = source.ingredients?.find((i) => i.id === id);
    if (!ingredient) return id;

    const existing = findExisting(target.ingredients, ingredient, space);
    if (existing) {
      ingredientIds.set(id, existing.id);
      return existing.id;
    }

    const copy = clone(ingredient);
    copy.id = crypto.randomUUID();
    copy.copiedFrom = provenance(ingredient.id);
    ingredientIds.set(id, copy.id);
    copy.ingredients = (copy.ingredients ?? []).map((row) => ({
      ...row,
      id: row.id === undefined ? undefined : ingredientId(row.id),
    }));
    target.ingredients.unshift(copy);
    return copy.id;
  };

  const lookupId = (list, targetList, id) => {
    if (id === undefined || id === null || id === "") return id;
    const record = list?.find((r) => r.id === id);
    if (!record) return id;
    const existing = findExisting(targetList, record, space);
    if (existing) return existing.id;
    const copy = clone(record);
    copy.id = crypto.randomUUID();
    copy.copiedFrom = provenance(record.id);
    targetList.push(copy);
    return copy.id;
  };

  const copy = clone(cocktail);
  copy.id = crypto.randomUUID();
  copy.event = "null";
  copy.copiedFrom = provenance(cocktail.id);
  const remapRows = (rows) =>
    (rows ?? []).map((row) => ({
      ...row,
      id: row.id === undefined ? undefined : ingredientId(row.id),
    }));
  copy.ingredients = remapRows(copy.ingredients);
  copy.garnishes = remapRows(copy.garnishes);
  copy.method = lookupId(source.prepMethods, target.prepMethods, cocktail.method);
  copy.glass = lookupId(source.glassTypes, target.glassTypes, cocktail.glass);

  target.cocktails.unshift(copy);
  return copy.id;
}
