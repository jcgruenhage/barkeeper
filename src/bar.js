// A permanent bar: its stock, what it can make from it, and what to buy.
//
// Stock is set, not counted down: someone looks at the shelf and writes down
// how much there is. An ingredient's stock entry holds counts of its sizes
// ("2.4 bottles of 700 ml") and a loose amount in its base unit, for what is
// not in a size, like a batch of syrup. An ingredient without an entry is not
// tracked and never runs out; an entry that adds up to zero means it is out.

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

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
