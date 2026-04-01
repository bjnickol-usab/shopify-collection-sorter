import { json } from "@remix-run/node";
import {
  getAllActiveSchedules,
  getFeaturedProducts,
  updateCollectionSortedAt,
  updateScheduleRunResult,
  supabase,
} from "../db.server.js";
import { createAdminApiClient } from "@shopify/admin-api-client";

// Verify request is from Vercel Cron
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
      title
      products(first: $first, after: $after) {
        edges {
          node { id totalInventory }
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
  // Try offline session first
  const { data: offlineSessions } = await supabase
    .from("shopify_sessions")
    .select("access_token, expires")
    .eq("shop", shopDomain)
    .eq("is_online", false)
    .not("access_token", "is", null)
    .order("expires", { ascending: false })
    .limit(1);

  if (offlineSessions?.[0]?.access_token) {
    console.log(`[CRON] Found offline session for ${shopDomain}`);
    return offlineSessions[0].access_token;
  }

  // Fall back to online session (token exchange strategy stores online sessions)
  const { data: onlineSessions } = await supabase
    .from("shopify_sessions")
    .select("access_token, expires")
    .eq("shop", shopDomain)
    .not("access_token", "is", null)
    .order("expires", { ascending: false })
    .limit(1);

  if (onlineSessions?.[0]?.access_token) {
    console.log(`[CRON] Found online session for ${shopDomain}`);
    return onlineSessions[0].access_token;
  }

  return null;
}

async function sortCollectionForShop(client, shopDomain, collectionId) {
  // Fetch all products (paginated)
  let products = [];
  let after = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const { data } = await client.request(GET_COLLECTION_PRODUCTS, {
      variables: { collectionId, first: 100, after },
    });
    const edges = data?.collection?.products?.edges || [];
    products = products.concat(edges.map((e) => e.node));
    hasNextPage = data?.collection?.products?.pageInfo?.hasNextPage || false;
    after = data?.collection?.products?.pageInfo?.endCursor || null;
    if (edges.length === 0) break;
  }

  if (products.length === 0) {
    return { success: true, productCount: 0, featuredCount: 0 };
  }

  // Get featured products from Supabase
  const featuredRows = await getFeaturedProducts(shopDomain, collectionId);
  const featuredIds = new Set(featuredRows.map((r) => r.product_id));

  // 4-tier sort:
  // 1) Featured + in stock (in saved order)
  // 2) Non-featured + in stock (high → low)
  // 3) Non-featured + out of stock
  // 4) Featured + out of stock (demoted to bottom)
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

  const sortedOrder = [
    ...featuredInStock,
    ...nonFeaturedInStock,
    ...nonFeaturedOOS,
    ...featuredOOS,
  ];

  // Set to MANUAL sort
  const setManualResult = await client.request(SET_COLLECTION_MANUAL_SORT, {
    variables: { input: { id: collectionId, sortOrder: "MANUAL" } },
  });
  const manualErrors = setManualResult.data?.collectionUpdate?.userErrors;
  if (manualErrors?.length > 0) {
    throw new Error(manualErrors[0].message);
  }

  // Reorder in batches of 250
  const moves = sortedOrder.map((p, i) => ({ id: p.id, newPosition: String(i) }));
  const BATCH_SIZE = 250;
  for (let i = 0; i < moves.length; i += BATCH_SIZE) {
    const reorderResult = await client.request(REORDER_PRODUCTS, {
      variables: { id: collectionId, moves: moves.slice(i, i + BATCH_SIZE) },
    });
    const reorderErrors = reorderResult.data?.collectionReorderProducts?.userErrors;
    if (reorderErrors?.length > 0) throw new Error(reorderErrors[0].message);
  }

  return {
    success: true,
    productCount: sortedOrder.length,
    featuredCount: featuredInStock.length + featuredOOS.length,
  };
}

export async function loader({ request }) {
  if (!verifyCronRequest(request)) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  console.log(`[CRON] Running daily sort at ${now.toISOString()}`);

  const schedules = await getAllActiveSchedules();
  console.log(`[CRON] ${schedules.length} active schedules to process`);

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

    // Get access token — tries offline first, falls back to online
    const accessToken = await getAccessTokenForShop(shopDomain);

    if (!accessToken) {
      const msg = "No session found — user must open the app to refresh their session";
      console.error(`[CRON] ${shopDomain}: ${msg}`);
      await updateScheduleRunResult(shopDomain, "error", msg);
      results.push({ shop: shopDomain, status: "error", message: msg });
      continue;
    }

    // Create Shopify Admin API client
    const client = createAdminApiClient({
      storeDomain: shopDomain,
      apiVersion: "2025-01",
      accessToken,
    });

    const collectionResults = [];

    for (const collectionId of collectionIds) {
      try {
        const result = await sortCollectionForShop(client, shopDomain, collectionId);
        await updateCollectionSortedAt(shopDomain, collectionId, "");
        collectionResults.push({ collectionId, ...result });
        console.log(`[CRON] Sorted ${collectionId} for ${shopDomain}: ${result.productCount} products`);
      } catch (err) {
        collectionResults.push({ collectionId, success: false, message: err.message });
        console.error(`[CRON] Error sorting ${collectionId} for ${shopDomain}:`, err.message);
      }
    }

    const succeeded = collectionResults.filter((r) => r.success).length;
    const failed = collectionResults.filter((r) => !r.success).length;
    const status = failed === 0 ? "success" : succeeded > 0 ? "partial" : "error";
    const summary = `${succeeded} of ${collectionIds.length} collections sorted successfully${failed > 0 ? `, ${failed} failed` : ""}`;

    await updateScheduleRunResult(shopDomain, status, summary);
    results.push({ shop: shopDomain, status, summary, collectionResults });
    console.log(`[CRON] ${shopDomain}: ${summary}`);
  }

  return json({ success: true, time: now.toISOString(), processed: schedules.length, results });
}
