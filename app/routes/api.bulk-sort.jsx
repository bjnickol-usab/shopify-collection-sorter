import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server.js";
import { getFeaturedProducts, updateCollectionSortedAt } from "../db.server.js";

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

    // Get featured products from Supabase
    const featuredRows = await getFeaturedProducts(shopDomain, collectionId);
    const featuredIds = new Set(featuredRows.map((r) => r.product_id));

    const featuredProducts = featuredRows
      .map((f) => products.find((p) => p.id === f.product_id))
      .filter(Boolean);

    const nonFeatured = products
      .filter((p) => !featuredIds.has(p.id))
      .sort((a, b) => (b.totalInventory || 0) - (a.totalInventory || 0));

    const sortedOrder = [...featuredProducts, ...nonFeatured];

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
      featuredCount: featuredProducts.length,
    });

  } catch (error) {
    console.error("Bulk sort error:", error);
    return json({ success: false, collectionId, message: error.message });
  }
}
