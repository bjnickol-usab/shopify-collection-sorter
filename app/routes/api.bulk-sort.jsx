import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server.js";
import { getFeaturedProducts, updateCollectionSortedAt, getPositionSnapshot, savePositionSnapshot, getCollectionSortSettings } from "../db.server.js";
import { buildNormalSortOrder, buildOOSSortOrder, createSnapshotFromCurrentOrder } from "../sort.server.js";

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
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
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
    // Fetch all products (paginated)
    let products = [];
    let after = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const response = await admin.graphql(GET_COLLECTION_PRODUCTS, {
        variables: { collectionId, first: 100, after },
      });
      const { data } = await response.json();
      const edges = data?.collection?.products?.edges || [];
      products = products.concat(edges.map((e) => e.node));
      hasNextPage = data?.collection?.products?.pageInfo?.hasNextPage || false;
      after = data?.collection?.products?.pageInfo?.endCursor || null;
      if (edges.length === 0) break;
    }

    // Check if OOS-only mode is enabled for this collection
    const collectionSettings = await getCollectionSortSettings(shopDomain, collectionId);
    const oosOnlyMode = collectionSettings?.oos_only_mode || false;

    let sortedOrder;
    const featuredRows = await getFeaturedProducts(shopDomain, collectionId);

    if (oosOnlyMode) {
      // OOS-only: restore in-stock to original positions, move OOS to bottom
      const { snapshot } = await getPositionSnapshot(shopDomain, collectionId);
      const currentSnapshot = Object.keys(snapshot).length > 0
        ? snapshot
        : createSnapshotFromCurrentOrder(products);
      const { sortedOrder: oosSorted, updatedSnapshot } = buildOOSSortOrder(products, currentSnapshot);
      sortedOrder = oosSorted;
      await savePositionSnapshot(shopDomain, collectionId, updatedSnapshot);
    } else {
      // Normal 4-tier sort
      sortedOrder = buildNormalSortOrder(products, featuredRows);
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

    // Batch reorder (250 per call)
    const moves = sortedOrder.map((product, index) => ({
      id: product.id,
      newPosition: String(index),
    }));

    const BATCH_SIZE = 250;
    for (let i = 0; i < moves.length; i += BATCH_SIZE) {
      const batch = moves.slice(i, i + BATCH_SIZE);
      const reorderResponse = await admin.graphql(REORDER_PRODUCTS, {
        variables: { id: collectionId, moves: batch },
      });
      const reorderData = await reorderResponse.json();
      const reorderErrors = reorderData.data?.collectionReorderProducts?.userErrors;
      if (reorderErrors?.length > 0) {
        return json({ success: false, collectionId, message: reorderErrors[0].message });
      }
    }

    // Save timestamp
    await updateCollectionSortedAt(shopDomain, collectionId, collectionTitle);

    return json({
      success: true,
      collectionId,
      productCount: sortedOrder.length,
      featuredCount: oosOnlyMode ? 0 : featuredRows.length,
      oosOnlyMode,
    });

  } catch (error) {
    console.error("Bulk sort error:", error);
    return json({ success: false, collectionId, message: error.message });
  }
}
