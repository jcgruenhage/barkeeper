// The default shape of a new record, shared by the UI and the importer so that
// an imported record is indistinguishable from one added by hand.

import { SHAKEN_ID, STIRRED_ID } from "./migrate.js";

function uuid() {
  return globalThis.crypto.randomUUID();
}

export function defaultIngredient(name, newId = uuid) {
  return {
    id: newId(),
    name: name,
    baseUnit: 'ml',
    units: [],
    ingredients: [],
    yield: 0,
    sizes: [],
    allergens: [],
    nonVeganIngredients: [],
    notes: '',
    safetyFactor: 0.1,
    abv: 0,
    color: '#e9ecef',
    hideInShoppingList: false,
  };
}

export function defaultCocktail(name, event = 'null', newId = uuid) {
  return {
    id: newId(),
    name: name,
    ingredients: [],
    garnishes: [],
    notes: '',
    cubes: 0,
    crushed: 0,
    largeCubes: 0,
    cubesServing: 0,
    crushedServing: 0,
    largeCubesServing: 0,
    method: undefined,
    glass: undefined,
    event: event,
    numToPrep: 0,
    price: 0,
    flavorCues: [],
  };
}

export function defaultPrepMethod(name, newId = uuid) {
  return { id: newId(), name: name, dilutionFormula: '1' };
}

export function defaultGlassType(name, newId = uuid) {
  return { id: newId(), name: name, volume: 0 };
}

/** The prep methods every space starts with. */
export function defaultPrepMethods() {
  return [
    {
      id: STIRRED_ID,
      name: 'stirred',
      dilutionFormula: '1 + (-1.21 * abv^2 + 1.246 * abv + 0.145)',
    },
    {
      id: SHAKEN_ID,
      name: 'shaken',
      dilutionFormula: '1 + (-1.567 * abv^2 + 1.742 * abv + 0.0203)',
    },
  ];
}
