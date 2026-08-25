/**
 * Shared sort logic - used by app.collection.jsx, api.bulk-sort.jsx, api.cron.jsx
 *
 * NORMAL MODE (4-tier):
 *   1. Featured + in stock (saved order)
 *   2. Non-featured + in stock (high → low inventory)
 *   3. Non-featured + out of stock
 *   4. Featured + out of stock (demoted)
 *
 * OOS-ONLY MODE:
 *   - Only moves OOS items to bottom
 *   - In-stock items maintain canonical order from position snapshot
 *   - Restores items to original position when back in stock
 *
 * INVENTORY SOURCE:
 *   - If selectedLocationIds is set and non-empty, OOS is determined by
 *     summing inventory only at those locations (locationInventory map)
 *   - Otherwise falls back to product.totalInventory
 */

/**
 * Get effective inventory for a product.
 * @param {Object} product - product with totalInventory
 * @param {Object} locationInventory - map of {productId: locationInventoryTotal}
 * @returns {number}
 */
export function getEffectiveInventory(product, locationInventory = {}) {
  if (locationInventory && Object.keys(locationInventory).length > 0) {
    return locationInventory[product.id] ?? 0;
  }
  return product.totalInventory || 0;
}

/**
 * Build sorted order for NORMAL mode.
 */
export function buildNormalSortOrder(products, featuredRows, locationInventory = {}) {
  const featuredIds = new Set(featuredRows.map((r) => r.product_id));

  const featuredInStock = featuredRows
    .map((f) => products.find((p) => p.id === f.product_id))
    .filter(Boolean)
    .filter((p) => getEffectiveInventory(p, locationInventory) > 0);

  const featuredOOS = featuredRows
    .map((f) => products.find((p) => p.id === f.product_id))
    .filter(Boolean)
    .filter((p) => getEffectiveInventory(p, locationInventory) <= 0);

  const nonFeaturedInStock = products
    .filter((p) => !featuredIds.has(p.id) && getEffectiveInventory(p, locationInventory) > 0)
    .sort((a, b) => getEffectiveInventory(b, locationInventory) - getEffectiveInventory(a, locationInventory));

  const nonFeaturedOOS = products
    .filter((p) => !featuredIds.has(p.id) && getEffectiveInventory(p, locationInventory) <= 0);

  return [...featuredInStock, ...nonFeaturedInStock, ...nonFeaturedOOS, ...featuredOOS];
}

/**
 * Build sorted order for OOS-ONLY mode.
 */
export function buildOOSSortOrder(products, snapshot, locationInventory = {}) {
  const inStock = products.filter((p) => getEffectiveInventory(p, locationInventory) > 0);
  const oos = products.filter((p) => getEffectiveInventory(p, locationInventory) <= 0);

  const existingRanks = Object.values(snapshot);
  let maxRank = existingRanks.length > 0 ? Math.max(...existingRanks) : -1;

  const updatedSnapshot = { ...snapshot };

  for (const product of products) {
    if (updatedSnapshot[product.id] === undefined) {
      maxRank += 1;
      updatedSnapshot[product.id] = maxRank;
    }
  }

  const sortedInStock = [...inStock].sort((a, b) => {
    return (updatedSnapshot[a.id] ?? 999999) - (updatedSnapshot[b.id] ?? 999999);
  });

  const sortedOOS = [...oos].sort((a, b) => {
    return (updatedSnapshot[a.id] ?? 999999) - (updatedSnapshot[b.id] ?? 999999);
  });

  return {
    sortedOrder: [...sortedInStock, ...sortedOOS],
    updatedSnapshot,
  };
}

/**
 * Create a snapshot from the current product order.
 */
export function createSnapshotFromCurrentOrder(products) {
  const snapshot = {};
  products.forEach((p, i) => { snapshot[p.id] = i; });
  return snapshot;
}

const GET_INVENTORY_LEVELS_BATCH = `
  query GetInventoryLevelsBatch($ids: [ID!]!, $first: Int!) {
    nodes(ids: $ids) {
      ... on InventoryItem {
        id
        inventoryLevels(first: $first) {
          edges {
            node {
              location { id }
              quantities(names: ["available"]) {
                name
                quantity
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * Fetch location inventory for a list of products using selected location IDs.
 * Returns a map of { productId: totalInventoryAtSelectedLocations }
 *
 * Batches inventory item lookups through the `nodes` query instead of firing
 * one request per variant — a 100-product collection with a few variants
 * each used to mean 150-350 sequential/parallel round trips, which was the
 * main source of the slow "Manage" page load.
 *
 * @param {Function} adminGraphql - Shopify admin.graphql function
 * @param {Array} products - [{id, variants}] where variants have inventoryItem
 * @param {Array} selectedLocationIds - location GIDs to sum inventory from
 * @returns {Object} { productId: number }
 */
export async function fetchLocationInventory(adminGraphql, products, selectedLocationIds) {
  if (!selectedLocationIds || selectedLocationIds.length === 0) {
    return {};
  }

  const locationInventory = {};
  const locationIdSet = new Set(selectedLocationIds);

  // Map each inventory item id to the product(s) it belongs to, so a single
  // batched response can be redistributed back to the right products.
  const productIdsByItemId = new Map();
  for (const product of products) {
    locationInventory[product.id] = 0;
    for (const variant of product.variants || []) {
      const itemId = variant.inventoryItem?.id;
      if (!itemId) continue;
      if (!productIdsByItemId.has(itemId)) {
        productIdsByItemId.set(itemId, []);
      }
      productIdsByItemId.get(itemId).push(product.id);
    }
  }

  const itemIds = [...productIdsByItemId.keys()];
  if (itemIds.length === 0) {
    return locationInventory;
  }

  // Keep each batch small enough that nesting inventoryLevels(first: 50)
  // under it stays well within the Admin API's per-query cost limit.
  const BATCH_SIZE = 15;
  const CONCURRENCY = 4;
  const batches = [];
  for (let i = 0; i < itemIds.length; i += BATCH_SIZE) {
    batches.push(itemIds.slice(i, i + BATCH_SIZE));
  }

  let cursor = 0;
  async function worker() {
    while (cursor < batches.length) {
      const batch = batches[cursor++];
      const response = await adminGraphql(GET_INVENTORY_LEVELS_BATCH, {
        variables: { ids: batch, first: 50 },
      });
      const { data } = await response.json();
      const nodes = data?.nodes || [];

      for (const node of nodes) {
        if (!node?.id) continue;
        const productIds = productIdsByItemId.get(node.id);
        if (!productIds) continue;

        let itemTotal = 0;
        const levels = node.inventoryLevels?.edges || [];
        for (const { node: level } of levels) {
          if (locationIdSet.has(level.location.id)) {
            itemTotal += level.quantities?.find((q) => q.name === "available")?.quantity || 0;
          }
        }
        for (const productId of productIds) {
          locationInventory[productId] += itemTotal;
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker)
  );

  return locationInventory;
}
