// Units of an ingredient and how they convert to its base unit.

/**
 * The conversions from the global table that apply to an ingredient, as
 * [unit, amount in the base unit] pairs.
 */
export function standardUnits(ingredient, unitConvTable = []) {
  const units = [];
  unitConvTable.forEach((entry) => {
    if (entry[0] === ingredient.baseUnit) { units.push([entry[1], 1/entry[2]]) };
    if (entry[1] === ingredient.baseUnit) { units.push([entry[0], entry[2]]) };
  });
  return units;
}

/**
 * The ingredient's own conversions followed by the standard ones. Unless
 * `dedupe` is false, each unit is listed once, and a standard conversion wins
 * over the ingredient's own.
 */
export function ingredientUnits(ingredient, unitConvTable = [], dedupe = true) {
  const units = [...(ingredient.units ?? []), ...standardUnits(ingredient, unitConvTable)];
  return dedupe ? [...new Map(units)] : units;
}

/**
 * How much of the base unit one `unit` of the ingredient is. Units without a
 * conversion count as the base unit.
 */
export function conversionFactor(ingredient, unit, unitConvTable = []) {
  if (unit === ingredient.baseUnit) return 1;
  const entry = ingredientUnits(ingredient, unitConvTable).find((e) => e[0] === unit);
  return entry ? entry[1] : 1;
}
