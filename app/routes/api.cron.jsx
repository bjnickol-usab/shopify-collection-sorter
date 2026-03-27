import { json } from "@remix-run/node";
import { getAllActiveSchedules, getFeaturedProducts, updateCollectionSortedAt, updateScheduleRunResult } from "../db.server.js";
import { createAdminApiClient } from "@shopify/admin-api-client";

// Verify request is from Vercel Cron
function verifyCronRequest(request) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return true; // Skip check if not configured (dev)
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

async function sortCollectionForShop(client, shopDomain, collectionId) {
  // Fetch all products
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

  if (products.length === 0) return { success: true, productCount: 0, featuredCount: 0 };

  // Get featured products
  const featuredRows = await getFeaturedProducts(shopDomain, collectionId);
  const featuredIds = new Set(featuredRows.map((r) => r.product_id));

  const featuredProducts = featuredRows
    .map((f) => products.find((p) => p.id === f.product_id))
    .filter(Boolean);

  const nonFeatured = products
    .filter((p) => !featuredIds.has(p.id))
    .sort((a, b) => (b.totalInventory || 0) - (a.totalInventory || 0));

  const sortedOrder = [...featuredProducts, ...nonFeatured];

  // Set to MANUAL
  const setManualResult = await client.request(SET_COLLECTION_MANUAL_SORT, {
    variables: { input: { id: collectionId, sortOrder: "MANUAL" } },
  });
  const manualErrors = setManualResult.data?.collectionUpdate?.userErrors;
  if (manualErrors?.length > 0) {
    throw new Error(manualErrors[0].message);
  }

  // Reorder in batches
  const moves = sortedOrder.map((p, i) => ({ id: p.id, newPosition: String(i) }));
  const BATCH_SIZE = 250;
  for (let i = 0; i < moves.length; i += BATCH_SIZE) {
    const reorderResult = await client.request(REORDER_PRODUCTS, {
      variables: { id: collectionId, moves: moves.slice(i, i + BATCH_SIZE) },
    });
    const reorderErrors = reorderResult.data?.collectionReorderProducts?.userErrors;
    if (reorderErrors?.length > 0) throw new Error(reorderErrors[0].message);
  }

  return { success: true, productCount: sortedOrder.length, featuredCount: featuredProducts.length };
}

export async function loader({ request }) {
  // Vercel cron jobs use GET
  if (!verifyCronRequest(request)) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const currentHour = now.getUTCHours();

  console.log(`[CRON] Running at UTC hour ${currentHour}`);

  const schedules = await getAllActiveSchedules();
  const due = schedules.filter((s) => s.run_hour === currentHour);

  console.log(`[CRON] ${schedules.length} active schedules, ${due.length} due now`);

  if (due.length === 0) {
    return json({ message: "No schedules due at this hour", hour: currentHour });
  }

  const results = [];

  for (const schedule of due) {
    const shopDomain = schedule.shop_domain;
    const collectionIds = schedule.collection_ids || [];

    if (collectionIds.length === 0) {
      results.push({ shop: shopDomain, status: "skipped", message: "No collections configured" });
      continue;
    }

    // Get the shop's access token from sessions
    const { supabase } = await import("../db.server.js");
    const { data: sessions } = await supabase
      .from("shopify_sessions")
      .select("access_token")
      .eq("shop", shopDomain)
      .eq("is_online", false)
      .limit(1);

    const accessToken = sessions?.[0]?.access_token;
    if (!accessToken) {
      const msg = "No offline session found";
      await updateScheduleRunResult(shopDomain, "error", msg);
      results.push({ shop: shopDomain, status: "error", message: msg });
      continue;
    }

    // Create admin API client
    const client = createAdminApiClient({
      storeDomain: shopDomain,
      apiVersion: "2025-01",
      accessToken,
    });

    const collectionResults = [];
    let hasError = false;

    for (const collectionId of collectionIds) {
      try {
        const result = await sortCollectionForShop(client, shopDomain, collectionId);
        await updateCollectionSortedAt(shopDomain, collectionId, "");
        collectionResults.push({ collectionId, ...result });
      } catch (err) {
        hasError = true;
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

  return json({ success: true, hour: currentHour, processed: due.length, results });
}
