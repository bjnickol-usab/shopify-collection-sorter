import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server.js";
import {
  getFeaturedProducts,
  updateCollectionSortedAt,
  getPositionSnapshot,
  savePositionSnapshot,
  getCollectionSortSettings,
  getShopSettings,
} from "../db.server.js";
import {
  buildNormalSortOrder,
  buildOOSSortOrder,
  createSnapshotFromCurrentOrder,
  fetchLocationInventory,
} from "../sort.server.js";

const SET_COLLECTION_MANUAL_SORT = `
  mutation CollectionUpdate($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection { id sortOrder }
      userErrors { field message }
    }
  }
`;

const GET_COLLECTION_PRODUCTS = `
  query GetCollectionProducts($collectionId: ID!, $first: Int!, $after: String) {
    collection(id: $collectionId) {
      id
      title
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

const REORDER_PRODUCTS = `
  mutation CollectionReorderProducts($id: ID!, $moves: [MoveInput!]!) {
    collectionReorderProducts(id: $id, moves: $moves) {
      job { id }
      userErrors { field message }
    }
  }
`;

export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const formData = await request.formData();
  const collectionId = formData.get("collectionId");
  const collectionTitle = formData.get("collectionTitle") || "";

  try {
    // Fetch all products (with variants for location inventory)
    let products = [];
    let after = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const response = await admin.graphql(GET_COLLECTION_PRODUCTS, {
        variables: { collectionId, first: 100, after },
      });
      const { data } = await response.json();
      const edges = data?.collection?.products?.edges || [];
      products = products.concat(edges.map((e) => ({
        ...e.node,
        variants: e.node.variants?.edges?.map((v) => v.node) || [],
      })));
      hasNextPage = data?.collection?.products?.pageInfo?.hasNextPage || false;
      after = data?.collection?.products?.pageInfo?.endCursor || null;
      if (edges.length === 0) break;
    }

    // Get location settings
    const shopSettings = await getShopSettings(shopDomain);
    const selectedLocationIds = shopSettings?.selected_location_ids || [];

    // Fetch location-based inventory if locations are configured
    const locationInventory = await fetchLocationInventory(
      admin.graphql.bind(admin),
      products,
      selectedLocationIds
    );

    // Get OOS mode and featured products
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

    // Set to MANUAL sort
    const setManualResponse = await admin.graphql(SET_COLLECTION_MANUAL_SORT, {
      variables: { input: { id: collectionId, sortOrder: "MANUAL" } },
    });
    const setManualData = await setManualResponse.json();
    const manualErrors = setManualData.data?.collectionUpdate?.userErrors;
    if (manualErrors?.length > 0) {
      return json({ success: false, collectionId, message: manualErrors[0].message });
    }

    // Reorder in batches of 250
    const moves = sortedOrder.map((p, i) => ({ id: p.id, newPosition: String(i) }));
    const BATCH_SIZE = 250;
    for (let i = 0; i < moves.length; i += BATCH_SIZE) {
      const reorderResponse = await admin.graphql(REORDER_PRODUCTS, {
        variables: { id: collectionId, moves: moves.slice(i, i + BATCH_SIZE) },
      });
      const reorderData = await reorderResponse.json();
      const reorderErrors = reorderData.data?.collectionReorderProducts?.userErrors;
      if (reorderErrors?.length > 0) {
        return json({ success: false, collectionId, message: reorderErrors[0].message });
      }
    }

    await updateCollectionSortedAt(shopDomain, collectionId, collectionTitle);

    return json({
      success: true,
      collectionId,
      productCount: sortedOrder.length,
      featuredCount: oosOnlyMode ? 0 : featuredRows.length,
      locationCount: selectedLocationIds.length,
      oosOnlyMode,
    });

  } catch (error) {
    console.error("Bulk sort error:", error);
    return json({ success: false, collectionId, message: error.message });
  }
}
