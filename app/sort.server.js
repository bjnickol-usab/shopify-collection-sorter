/**
 * Shared sort logic used by:
 * - app.collection.jsx (individual sort)
 * - api.bulk-sort.jsx (bulk sort)
 * - api.cron.jsx (scheduled sort)
 *
 * Two modes:
 *
 * NORMAL MODE (4-tier):
 *   1. Featured + in stock (saved order)
 *   2. Non-featured + in stock (high → low inventory)
 *   3. Non-featured + out of stock
 *   4. Featured + out of stock (demoted)
 *
 * OOS-ONLY MODE:
 *   - Only moves OOS items to bottom
 *   - All in-stock items maintain their canonical order (from position snapshot)
 *   - OOS items go to bottom but keep their snapshot rank for restoration
 *   - When item comes back in stock → restored to original position
 */

/**
 * Build sorted order for NORMAL mode.
 * @param {Array} products - [{id, totalInventory}]
 * @param {Array} featuredRows - [{product_id}] in saved order
 * @returns {Array} sorted products
 */
export function buildNormalSortOrder(products, featuredRows) {
  const featuredIds = new Set(featuredRows.map((r) => r.product_id));

  const featuredInStock = featuredRows
    .map((f) => products.find((p) => p.id === f.product_id))
    .filter(Boolean)
    .filter((p) => (p.totalInventory || 0) > 0);

  const featuredOOS = featuredRows
    .map((f) => products.find((p) => p.id === f.product_id))
    .filter(Boolean)
    .filter((p) => (p.totalInventory || 0) <= 0);

  const nonFeaturedInStock = products
    .filter((p) => !featuredIds.has(p.id) && (p.totalInventory || 0) > 0)
    .sort((a, b) => (b.totalInventory || 0) - (a.totalInventory || 0));

  const nonFeaturedOOS = products
    .filter((p) => !featuredIds.has(p.id) && (p.totalInventory || 0) <= 0);

  return [...featuredInStock, ...nonFeaturedInStock, ...nonFeaturedOOS, ...featuredOOS];
}

/**
 * Build sorted order for OOS-ONLY mode.
 * @param {Array} products - [{id, totalInventory}] in current Shopify order
 * @param {Object} snapshot - {product_id: rank} canonical position map
 * @returns {{ sortedOrder: Array, updatedSnapshot: Object }}
 */
export function buildOOSSortOrder(products, snapshot) {
  const inStock = products.filter((p) => (p.totalInventory || 0) > 0);
  const oos = products.filter((p) => (p.totalInventory || 0) <= 0);

  // Find the highest existing rank so new products can be appended after
  const existingRanks = Object.values(snapshot);
  let maxRank = existingRanks.length > 0 ? Math.max(...existingRanks) : -1;

  // Build updated snapshot — preserve OOS product ranks, add new products
  const updatedSnapshot = { ...snapshot };
  const unranked = [];

  for (const product of products) {
    if (updatedSnapshot[product.id] === undefined) {
      unranked.push(product.id);
    }
  }

  // Assign new products ranks at the end (based on their current relative order)
  for (const productId of unranked) {
    maxRank += 1;
    updatedSnapshot[productId] = maxRank;
  }

  // Sort in-stock products by their snapshot rank
  const sortedInStock = [...inStock].sort((a, b) => {
    const rankA = updatedSnapshot[a.id] ?? 999999;
    const rankB = updatedSnapshot[b.id] ?? 999999;
    return rankA - rankB;
  });

  // OOS products also sorted by snapshot rank (so when they come back they restore correctly)
  const sortedOOS = [...oos].sort((a, b) => {
    const rankA = updatedSnapshot[a.id] ?? 999999;
    const rankB = updatedSnapshot[b.id] ?? 999999;
    return rankA - rankB;
  });

  return {
    sortedOrder: [...sortedInStock, ...sortedOOS],
    updatedSnapshot,
  };
}

/**
 * If no snapshot exists yet, create one from current product order.
 * @param {Array} products - in current Shopify order
 * @returns {Object} snapshot {product_id: rank}
 */
export function createSnapshotFromCurrentOrder(products) {
  const snapshot = {};
  products.forEach((p, i) => {
    snapshot[p.id] = i;
  });
  return snapshot;
}
