import { json } from "@remix-run/node";
import {
  useLoaderData,
  useFetcher,
  useNavigate,
} from "@remix-run/react";
import { useState, useCallback } from "react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Badge,
  Banner,
  Divider,
  Thumbnail,
  Icon,
  Toast,
  Frame,
  Spinner,
  EmptyState,
  Box,
} from "@shopify/polaris";
import { StarIcon, StarFilledIcon, ArrowUpIcon, ArrowDownIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server.js";
import {
  getFeaturedProducts,
  setFeaturedProducts,
  updateCollectionSortedAt,
  getCollectionSortSettings,
} from "../db.server.js";

// ─── GraphQL ──────────────────────────────────────────────────────────────────

const GET_COLLECTION_PRODUCTS = `
  query GetCollectionProducts($collectionId: ID!, $first: Int!, $after: String) {
    collection(id: $collectionId) {
      id
      title
      sortOrder
      productsCount { count }
      products(first: $first, after: $after) {
        edges {
          node {
            id
            title
            totalInventory
            featuredImage {
              url
              altText
            }
            status
            variants(first: 1) {
              edges {
                node {
                  id
                  sku
                }
              }
            }
          }
          cursor
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

const SET_COLLECTION_MANUAL_SORT = `
  mutation CollectionUpdate($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection {
        id
        sortOrder
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const REORDER_PRODUCTS = `
  mutation CollectionReorderProducts($id: ID!, $moves: [MoveInput!]!) {
    collectionReorderProducts(id: $id, moves: $moves) {
      job {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchAllProducts(admin, collectionId) {
  let all = [];
  let after = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await admin.graphql(GET_COLLECTION_PRODUCTS, {
      variables: { collectionId, first: 100, after },
    });
    const { data } = await response.json();
    const products = data?.collection?.products?.edges?.map((e) => e.node) || [];
    all = all.concat(products);
    hasNextPage = data?.collection?.products?.pageInfo?.hasNextPage || false;
    after = data?.collection?.products?.pageInfo?.endCursor || null;

    if (all.length === 0) break;
  }

  return all;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  // Decode the collection ID from the URL param
  const url = new URL(request.url);
  const collectionId = decodeURIComponent(url.searchParams.get("id") || "");

  // Fetch all products (paginated)
  let collection = null;
  let products = [];

  const firstResponse = await admin.graphql(GET_COLLECTION_PRODUCTS, {
    variables: { collectionId, first: 100, after: null },
  });
  const firstData = await firstResponse.json();
  collection = firstData.data?.collection;
  products = firstData.data?.collection?.products?.edges?.map((e) => e.node) || [];

  // Paginate if needed
  let hasNext = firstData.data?.collection?.products?.pageInfo?.hasNextPage;
  let after = firstData.data?.collection?.products?.pageInfo?.endCursor;

  while (hasNext) {
    const resp = await admin.graphql(GET_COLLECTION_PRODUCTS, {
      variables: { collectionId, first: 100, after },
    });
    const d = await resp.json();
    const more = d.data?.collection?.products?.edges?.map((e) => e.node) || [];
    products = products.concat(more);
    hasNext = d.data?.collection?.products?.pageInfo?.hasNextPage;
    after = d.data?.collection?.products?.pageInfo?.endCursor;
  }

  // Get featured products from Supabase
  const featuredRows = await getFeaturedProducts(shopDomain, collectionId);
  const featuredIds = new Set(featuredRows.map((r) => r.product_id));

  // Get last sorted info
  const sortSettings = await getCollectionSortSettings(shopDomain, collectionId);

  return json({
    collection: {
      id: collection?.id,
      title: collection?.title,
      sortOrder: collection?.sortOrder,
      productsCount: collection?.productsCount?.count ?? 0,
    },
    products,
    featuredIds: [...featuredIds],
    featuredOrder: featuredRows.map((r) => r.product_id),
    sortSettings,
    shopDomain,
    collectionId,
  });
}

// ─── Action ───────────────────────────────────────────────────────────────────

export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const url = new URL(request.url);
  const collectionId = decodeURIComponent(url.searchParams.get("id") || "");

  const formData = await request.formData();
  const intent = formData.get("intent");

  // ── Save featured products only ─────────────────────────────────────────────
  if (intent === "saveFeatured") {
    const featuredJson = formData.get("featured");
    const featured = JSON.parse(featuredJson);

    await setFeaturedProducts(shopDomain, collectionId, featured);
    return json({ success: true, message: "Featured products saved." });
  }

  // ── Apply sort to Shopify ────────────────────────────────────────────────────
  if (intent === "applySort") {
    const featuredJson = formData.get("featured");
    const productsJson = formData.get("products");
    const collectionTitle = formData.get("collectionTitle");

    const featured = JSON.parse(featuredJson);    // [{ product_id, product_title }]
    const products = JSON.parse(productsJson);    // [{ id, title, totalInventory }]

    // 1. Save featured products in Supabase
    await setFeaturedProducts(shopDomain, collectionId, featured);

    // 2. Set collection sort to MANUAL (required before reordering)
    const setManualResponse = await admin.graphql(SET_COLLECTION_MANUAL_SORT, {
      variables: {
        input: {
          id: collectionId,
          sortOrder: "MANUAL",
        },
      },
    });
    const setManualData = await setManualResponse.json();
    const manualErrors = setManualData.data?.collectionUpdate?.userErrors;
    if (manualErrors?.length > 0) {
      return json({ success: false, message: manualErrors[0].message }, { status: 400 });
    }

    // 3. Build sort order: featured first (in their order), then remaining sorted by inventory DESC
    const featuredSet = new Set(featured.map((f) => f.product_id));
    const featuredProducts = featured
      .map((f) => products.find((p) => p.id === f.product_id))
      .filter(Boolean);

    const nonFeatured = products
      .filter((p) => !featuredSet.has(p.id))
      .sort((a, b) => (b.totalInventory || 0) - (a.totalInventory || 0));

    const sortedOrder = [...featuredProducts, ...nonFeatured];

    // 4. Build moves array (Shopify uses 0-based index)
    const moves = sortedOrder.map((product, index) => ({
      id: product.id,
      newPosition: String(index),
    }));

    // 5. Apply reorder
    const reorderResponse = await admin.graphql(REORDER_PRODUCTS, {
      variables: { id: collectionId, moves },
    });
    const reorderData = await reorderResponse.json();
    const reorderErrors = reorderData.data?.collectionReorderProducts?.userErrors;
    if (reorderErrors?.length > 0) {
      return json({ success: false, message: reorderErrors[0].message }, { status: 400 });
    }

    // 6. Record sort timestamp
    await updateCollectionSortedAt(shopDomain, collectionId, collectionTitle);

    const featuredCount = featured.length;
    const totalCount = sortedOrder.length;
    return json({
      success: true,
      message: `Sort applied! ${featuredCount} featured product${featuredCount !== 1 ? "s" : ""} pinned to top, ${totalCount - featuredCount} sorted by inventory.`,
    });
  }

  return json({ success: false, message: "Unknown intent" }, { status: 400 });
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function CollectionDetail() {
  const { collection, products, featuredIds, featuredOrder, sortSettings } =
    useLoaderData();
  const fetcher = useFetcher();
  const navigate = useNavigate();

  // Local state for featured product IDs (ordered)
  const [featured, setFeatured] = useState(() => {
    // Build ordered list from featuredOrder
    return featuredOrder
      .map((id) => products.find((p) => p.id === id))
      .filter(Boolean);
  });

  const [toastActive, setToastActive] = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const [toastError, setToastError] = useState(false);

  const featuredSet = new Set(featured.map((p) => p.id));

  const isSaving = fetcher.state !== "idle";

  // Handle fetcher result
  const fetcherData = fetcher.data;
  if (fetcherData && !toastActive && fetcher.state === "idle") {
    if (fetcherData.message && fetcherData.message !== toastMessage) {
      setToastMessage(fetcherData.message);
      setToastError(!fetcherData.success);
      setToastActive(true);
    }
  }

  // Toggle featured
  const toggleFeatured = useCallback(
    (product) => {
      if (featuredSet.has(product.id)) {
        setFeatured((prev) => prev.filter((p) => p.id !== product.id));
      } else {
        setFeatured((prev) => [...prev, product]);
      }
    },
    [featuredSet]
  );

  // Move featured product up/down
  const moveFeatured = useCallback((productId, direction) => {
    setFeatured((prev) => {
      const idx = prev.findIndex((p) => p.id === productId);
      if (idx < 0) return prev;
      const newArr = [...prev];
      const swapIdx = direction === "up" ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= newArr.length) return prev;
      [newArr[idx], newArr[swapIdx]] = [newArr[swapIdx], newArr[idx]];
      return newArr;
    });
  }, []);

  // Non-featured products sorted by inventory desc (preview)
  const nonFeatured = products
    .filter((p) => !featuredSet.has(p.id))
    .sort((a, b) => (b.totalInventory || 0) - (a.totalInventory || 0));

  // Build payload
  const buildFeaturedPayload = () =>
    featured.map((p, i) => ({
      product_id: p.id,
      product_title: p.title,
      position: i + 1,
    }));

  const handleSaveFeatured = () => {
    const fd = new FormData();
    fd.set("intent", "saveFeatured");
    fd.set("featured", JSON.stringify(buildFeaturedPayload()));
    fetcher.submit(fd, { method: "post" });
  };

  const handleApplySort = () => {
    const fd = new FormData();
    fd.set("intent", "applySort");
    fd.set("featured", JSON.stringify(buildFeaturedPayload()));
    fd.set(
      "products",
      JSON.stringify(
        products.map((p) => ({
          id: p.id,
          title: p.title,
          totalInventory: p.totalInventory,
        }))
      )
    );
    fd.set("collectionTitle", collection.title);
    fetcher.submit(fd, { method: "post" });
  };

  const formatInventory = (qty) => {
    if (qty == null) return "—";
    if (qty < 0) return "0";
    return qty.toLocaleString();
  };

  const inventoryBadge = (qty) => {
    if (qty == null || qty <= 0) return <Badge tone="critical">Out of Stock</Badge>;
    if (qty < 10) return <Badge tone="warning">Low: {qty}</Badge>;
    return <Badge tone="success">{qty.toLocaleString()} in stock</Badge>;
  };

  return (
    <Frame>
      <Page
        title={collection.title}
        subtitle={`${collection.productsCount} products · Sort order: ${collection.sortOrder}`}
        backAction={{ content: "Dashboard", url: "/app" }}
        primaryAction={{
          content: isSaving ? "Applying…" : "Apply Sort to Shopify",
          disabled: isSaving,
          loading: isSaving,
          onAction: handleApplySort,
          tone: "success",
        }}
        secondaryActions={[
          {
            content: "Save Featured Only",
            disabled: isSaving,
            onAction: handleSaveFeatured,
          },
        ]}
      >
        <Layout>
          {/* Info banner */}
          <Layout.Section>
            <Banner title="How this works" tone="info">
              <p>
                Star ⭐ products to pin them at the top in the order you choose. All other products will be sorted automatically from <strong>highest inventory to lowest</strong>. Click <strong>Apply Sort to Shopify</strong> to publish the order to your store.
              </p>
            </Banner>
          </Layout.Section>

          {sortSettings?.last_sorted_at && (
            <Layout.Section>
              <Banner tone="success">
                Last sorted: <strong>{new Date(sortSettings.last_sorted_at).toLocaleString()}</strong>
              </Banner>
            </Layout.Section>
          )}

          <Layout.Section>
            <BlockStack gap="400">

              {/* Featured products section */}
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <BlockStack gap="100">
                      <Text variant="headingMd" as="h2">
                        ⭐ Featured Products ({featured.length})
                      </Text>
                      <Text variant="bodySm" tone="subdued">
                        These will appear at the top of the collection, in this order.
                      </Text>
                    </BlockStack>
                  </InlineStack>

                  {featured.length === 0 ? (
                    <Box padding="400" background="bg-surface-secondary" borderRadius="200">
                      <Text tone="subdued" alignment="center">
                        No featured products yet. Click ⭐ on any product below to pin it here.
                      </Text>
                    </Box>
                  ) : (
                    <BlockStack gap="200">
                      {featured.map((product, idx) => (
                        <div
                          key={product.id}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 12,
                            padding: "10px 12px",
                            background: "#fff9e6",
                            border: "1px solid #ffd700",
                            borderRadius: 8,
                          }}
                        >
                          <Text variant="bodyMd" tone="subdued" fontWeight="bold">
                            {idx + 1}
                          </Text>
                          <Thumbnail
                            source={product.featuredImage?.url || ""}
                            alt={product.title}
                            size="small"
                          />
                          <div style={{ flex: 1 }}>
                            <Text variant="bodyMd" fontWeight="semibold">
                              {product.title}
                            </Text>
                            <div style={{ marginTop: 4 }}>
                              {inventoryBadge(product.totalInventory)}
                            </div>
                          </div>
                          <InlineStack gap="100">
                            <Button
                              icon={ArrowUpIcon}
                              size="slim"
                              variant="plain"
                              disabled={idx === 0}
                              onClick={() => moveFeatured(product.id, "up")}
                              accessibilityLabel="Move up"
                            />
                            <Button
                              icon={ArrowDownIcon}
                              size="slim"
                              variant="plain"
                              disabled={idx === featured.length - 1}
                              onClick={() => moveFeatured(product.id, "down")}
                              accessibilityLabel="Move down"
                            />
                            <Button
                              size="slim"
                              tone="critical"
                              variant="plain"
                              onClick={() => toggleFeatured(product)}
                            >
                              Remove
                            </Button>
                          </InlineStack>
                        </div>
                      ))}
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>

              <Divider />

              {/* All products sorted by inventory */}
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <BlockStack gap="100">
                      <Text variant="headingMd" as="h2">
                        📦 All Products — sorted by inventory
                      </Text>
                      <Text variant="bodySm" tone="subdued">
                        Non-featured products will appear below your featured items, highest inventory first.
                        Click ⭐ to pin any product to the top.
                      </Text>
                    </BlockStack>
                    <Text variant="bodySm" tone="subdued">
                      {products.length} products
                    </Text>
                  </InlineStack>

                  {products.length === 0 && (
                    <EmptyState
                      heading="No products in this collection"
                      image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                    >
                      <p>Add products to this collection in Shopify admin.</p>
                    </EmptyState>
                  )}

                  {/* Featured products shown first (greyed out, already featured) */}
                  {featured.length > 0 && (
                    <BlockStack gap="100">
                      <Text variant="bodySm" tone="subdued" fontWeight="semibold">
                        📌 FEATURED (pinned above all others)
                      </Text>
                      {featured.map((product) => (
                        <ProductRow
                          key={product.id}
                          product={product}
                          isFeatured={true}
                          onToggle={toggleFeatured}
                          inventoryBadge={inventoryBadge}
                          formatInventory={formatInventory}
                          muted
                        />
                      ))}
                      <Divider />
                      <Text variant="bodySm" tone="subdued" fontWeight="semibold">
                        📊 SORTED BY INVENTORY (highest → lowest)
                      </Text>
                    </BlockStack>
                  )}

                  {/* Non-featured products, sorted by inventory */}
                  <BlockStack gap="100">
                    {nonFeatured.map((product, idx) => (
                      <ProductRow
                        key={product.id}
                        product={product}
                        isFeatured={false}
                        onToggle={toggleFeatured}
                        inventoryBadge={inventoryBadge}
                        formatInventory={formatInventory}
                        rank={featured.length + idx + 1}
                      />
                    ))}
                  </BlockStack>
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>
        </Layout>
      </Page>

      {toastActive && (
        <Toast
          content={toastMessage}
          error={toastError}
          onDismiss={() => setToastActive(false)}
          duration={4000}
        />
      )}
    </Frame>
  );
}

// ─── ProductRow sub-component ────────────────────────────────────────────────

function ProductRow({ product, isFeatured, onToggle, inventoryBadge, formatInventory, rank, muted }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "8px 12px",
        background: muted ? "#f9f9f9" : isFeatured ? "#fff9e6" : "white",
        border: `1px solid ${isFeatured ? "#ffd700" : "#e1e1e1"}`,
        borderRadius: 8,
        opacity: muted ? 0.65 : 1,
      }}
    >
      {rank && (
        <Text variant="bodySm" tone="subdued" fontWeight="bold" as="span">
          #{rank}
        </Text>
      )}
      <Thumbnail
        source={product.featuredImage?.url || ""}
        alt={product.title}
        size="small"
      />
      <div style={{ flex: 1 }}>
        <Text variant="bodyMd" fontWeight={isFeatured ? "semibold" : "regular"}>
          {product.title}
        </Text>
        <div style={{ marginTop: 4 }}>
          {inventoryBadge(product.totalInventory)}
        </div>
      </div>
      <div style={{ minWidth: 60, textAlign: "right" }}>
        <Text variant="bodyMd" tone="subdued">
          {formatInventory(product.totalInventory)} units
        </Text>
      </div>
      <Button
        size="slim"
        variant={isFeatured ? "primary" : "plain"}
        tone={isFeatured ? "success" : undefined}
        onClick={() => onToggle(product)}
        disabled={muted}
        icon={isFeatured ? StarFilledIcon : StarIcon}
      >
        {isFeatured ? "Featured" : "Feature"}
      </Button>
    </div>
  );
}
