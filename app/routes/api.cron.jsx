import { json } from "@remix-run/node";
import {
  getAllActiveSchedules,
  getFeaturedProducts,
  updateCollectionSortedAt,
  updateScheduleRunResult,
  getPositionSnapshot,
  savePositionSnapshot,
  getCollectionSortSettings,
  getShopSettings,
  supabase,
} from "../db.server.js";
import {
  buildNormalSortOrder,
  buildOOSSortOrder,
  createSnapshotFromCurrentOrder,
  fetchLocationInventory,
} from "../sort.server.js";
import { createAdminApiClient } from "@shopify/admin-api-client";

function verifyCronRequest(request) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return true;
  return authHeader === `Bearer ${cronSecret}`;
}

const GET_COLLECTION_PRODUCTS = `
  query GetCollectionProducts($collectionId: ID!, $first: Int!, $after: String) {
    collection(id: $collectionId) {
      id
      products(first: $first, after: $after) {
        edges {
          node {
            id
            totalInventory
            variants(first: 50) {
              edges {
                node {
                  inventoryItem { id }
                }
              }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const SET_COLLECTION_MANUAL_SORT = `
  mutation CollectionUpdate($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection { id }
      userErrors { field message }
    }
  }
`;

const REORDER_PRODUCTS = `
  mutation CollectionReorderProducts($id: ID!, $moves: [MoveInput!]!) {
    collectionReorderProducts(id: $id, moves: $moves) {
      job { id }
      userErrors { field message }
    }
  }
`;

async function getAccessTokenForShop(shopDomain) {
  const { data: offlineSessions } = await supabase
    .from("shopify_sessions")
    .select("access_token")
    .eq("shop", shopDomain)
    .eq("is_online", false)
    .not("access_token", "is", null)
    .order("expires", { ascending: false })
    .limit(1);

  if (offlineSessions?.[0]?.access_token) return offlineSessions[0].access_token;

  const { data: onlineSessions } = await supabase
    .from("shopify_sessions")
    .select("access_token")
    .eq("shop", shopDomain)
    .not("access_token", "is", null)
    .order("expires", { ascending: false })
    .limit(1);

  return onlineSessions?.[0]?.access_token || null;
}

// Wrap createAdminApiClient request to match admin.graphql signature
function makeGraphqlFn(client) {
  return async (query, options) => {
    const result = await client.request(query, options);
    // Wrap in a response-like object with .json()
    return { json: async () => result };
  };
}

async function sortCollectionForShop(client, shopDomain, collectionId, selectedLocationIds) {
  let products = [];
  let after = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const { data } = await client.request(GET_COLLECTION_PRODUCTS, {
      variables: { collectionId, first: 100, after },
    });
    const edges = data?.collection?.products?.edges || [];
    products = products.concat(edges.map((e) => ({
      ...e.node,
      variants: e.node.variants?.edges?.map((v) => v.node) || [],
    })));
    hasNextPage = data?.collection?.products?.pageInfo?.hasNextPage || false;
    after = data?.collection?.products?.pageInfo?.endCursor || null;
    if (edges.length === 0) break;
  }

  if (products.length === 0) return { success: true, productCount: 0, featuredCount: 0 };

  // Fetch location inventory
  const graphqlFn = makeGraphqlFn(client);
  const locationInventory = await fetchLocationInventory(graphqlFn, products, selectedLocationIds);

  // Get sort settings
  const collectionSettings = await getCollectionSortSettings(shopDomain, collectionId);
  const oosOnlyMode = collectionSettings?.oos_only_mode || false;
  const featuredRows = await getFeaturedProducts(shopDomain, collectionId);

  let sortedOrder;

  if (oosOnlyMode) {
    const { snapshot } = await getPositionSnapshot(shopDomain, collectionId);
    const currentSnapshot = Object.keys(snapshot).length > 0
      ? snapshot
      : createSnapshotFromCurrentOrder(products);
    const { sortedOrder: oosSorted, updatedSnapshot } = buildOOSSortOrder(
      products, currentSnapshot, locationInventory
    );
    sortedOrder = oosSorted;
    await savePositionSnapshot(shopDomain, collectionId, updatedSnapshot);
  } else {
    sortedOrder = buildNormalSortOrder(products, featuredRows, locationInventory);
  }

  // Set to MANUAL
  const setManualResult = await client.request(SET_COLLECTION_MANUAL_SORT, {
    variables: { input: { id: collectionId, sortOrder: "MANUAL" } },
  });
  if (setManualResult.data?.collectionUpdate?.userErrors?.length > 0) {
    throw new Error(setManualResult.data.collectionUpdate.userErrors[0].message);
  }

  // Reorder in batches
  const moves = sortedOrder.map((p, i) => ({ id: p.id, newPosition: String(i) }));
  const BATCH_SIZE = 250;
  for (let i = 0; i < moves.length; i += BATCH_SIZE) {
    const reorderResult = await client.request(REORDER_PRODUCTS, {
      variables: { id: collectionId, moves: moves.slice(i, i + BATCH_SIZE) },
    });
    if (reorderResult.data?.collectionReorderProducts?.userErrors?.length > 0) {
      throw new Error(reorderResult.data.collectionReorderProducts.userErrors[0].message);
    }
  }

  return {
    success: true,
    productCount: sortedOrder.length,
    featuredCount: oosOnlyMode ? 0 : featuredRows.length,
  };
}

export async function loader({ request }) {
  if (!verifyCronRequest(request)) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  console.log(`[CRON] Running daily sort at ${now.toISOString()}`);

  const schedules = await getAllActiveSchedules();
  console.log(`[CRON] ${schedules.length} active schedules`);

  if (schedules.length === 0) {
    return json({ message: "No active schedules", time: now.toISOString() });
  }

  const results = [];

  for (const schedule of schedules) {
    const shopDomain = schedule.shop_domain;
    const collectionIds = schedule.collection_ids || [];

    if (collectionIds.length === 0) {
      results.push({ shop: shopDomain, status: "skipped", message: "No collections configured" });
      continue;
    }

    const accessToken = await getAccessTokenForShop(shopDomain);
    if (!accessToken) {
      const msg = "No session found — user must open the app to refresh their session";
      await updateScheduleRunResult(shopDomain, "error", msg);
      results.push({ shop: shopDomain, status: "error", message: msg });
      continue;
    }

    // Get location settings for this shop
    const shopSettings = await getShopSettings(shopDomain);
    const selectedLocationIds = shopSettings?.selected_location_ids || [];

    const client = createAdminApiClient({
      storeDomain: shopDomain,
      apiVersion: "2025-10",
      accessToken,
    });

    const collectionResults = [];

    for (const collectionId of collectionIds) {
      try {
        const result = await sortCollectionForShop(client, shopDomain, collectionId, selectedLocationIds);
        await updateCollectionSortedAt(shopDomain, collectionId, "");
        collectionResults.push({ collectionId, ...result });
      } catch (err) {
        collectionResults.push({ collectionId, success: false, message: err.message });
        console.error(`[CRON] Error sorting ${collectionId} for ${shopDomain}:`, err.message);
      }
    }

    const succeeded = collectionResults.filter((r) => r.success).length;
    const failed = collectionResults.filter((r) => !r.success).length;
    const status = failed === 0 ? "success" : succeeded > 0 ? "partial" : "error";
    const summary = `${succeeded} of ${collectionIds.length} collections sorted${selectedLocationIds.length > 0 ? ` (${selectedLocationIds.length} locations)` : ""}${failed > 0 ? `, ${failed} failed` : ""}`;

    await updateScheduleRunResult(shopDomain, status, summary);
    results.push({ shop: shopDomain, status, summary, collectionResults });
    console.log(`[CRON] ${shopDomain}: ${summary}`);
  }

  return json({ success: true, time: now.toISOString(), processed: schedules.length, results });
}
