import { json } from "@remix-run/node";
import { useLoaderData, useNavigate, useFetcher } from "@remix-run/react";
import { useState, useCallback } from "react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  Button,
  InlineStack,
  Badge,
  Thumbnail,
  TextField,
  EmptyState,
  Checkbox,
  Banner,
  ProgressBar,
  Divider,
  Toast,
  Frame,
  Box,
  Icon,
} from "@shopify/polaris";
import { SortIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server.js";
import { getAllCollectionSettings, getFeaturedProducts } from "../db.server.js";

const GET_COLLECTIONS = `
  query GetCollections($first: Int!, $after: String) {
    collections(first: $first, after: $after) {
      edges {
        node {
          id
          title
          productsCount { count }
          sortOrder
          image {
            url
            altText
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
`;

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

const REORDER_PRODUCTS = `
  mutation CollectionReorderProducts($id: ID!, $moves: [MoveInput!]!) {
    collectionReorderProducts(id: $id, moves: $moves) {
      job { id }
      userErrors { field message }
    }
  }
`;

export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  let all = [];
  let after = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await admin.graphql(GET_COLLECTIONS, {
      variables: { first: 50, after },
    });
    const { data } = await response.json();
    const edges = data?.collections?.edges || [];
    all = all.concat(edges.map((e) => e.node));
    hasNextPage = data?.collections?.pageInfo?.hasNextPage || false;
    after = data?.collections?.pageInfo?.endCursor || null;
    if (edges.length === 0) break;
  }

  const sortSettings = await getAllCollectionSettings(shopDomain);
  const settingsMap = Object.fromEntries(
    sortSettings.map((s) => [s.collection_id, s])
  );

  const enriched = all.map((col) => ({
    ...col,
    productsCount: col.productsCount?.count ?? 0,
    settings: settingsMap[col.id] || null,
  }));

  return json({ collections: enriched, shopDomain });
}

export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const formData = await request.formData();
  const collectionId = formData.get("collectionId");

  try {
    // Fetch all products for this collection
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

    // Get featured products for this collection from Supabase
    const featuredRows = await getFeaturedProducts(shopDomain, collectionId);
    const featuredIds = new Set(featuredRows.map((r) => r.product_id));

    // Build sort order: featured first (in saved order), then by inventory DESC
    const featuredProducts = featuredRows
      .map((f) => products.find((p) => p.id === f.product_id))
      .filter(Boolean);

    const nonFeatured = products
      .filter((p) => !featuredIds.has(p.id))
      .sort((a, b) => (b.totalInventory || 0) - (a.totalInventory || 0));

    const sortedOrder = [...featuredProducts, ...nonFeatured];

    // Set collection to MANUAL sort
    const setManualResponse = await admin.graphql(SET_COLLECTION_MANUAL_SORT, {
      variables: { input: { id: collectionId, sortOrder: "MANUAL" } },
    });
    const setManualData = await setManualResponse.json();
    const manualErrors = setManualData.data?.collectionUpdate?.userErrors;
    if (manualErrors?.length > 0) {
      return json({ success: false, collectionId, message: manualErrors[0].message });
    }

    // Build and batch moves (250 max per call)
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

    // Update timestamp in Supabase
    const { updateCollectionSortedAt } = await import("../db.server.js");
    const collectionTitle = formData.get("collectionTitle") || "";
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

export default function CollectionsList() {
  const { collections } = useLoaderData();
  const navigate = useNavigate();
  const fetcher = useFetcher();

  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(new Set());
  const [sorting, setSorting] = useState(false);
  const [sortQueue, setSortQueue] = useState([]);
  const [sortProgress, setSortProgress] = useState({ done: 0, total: 0 });
  const [sortResults, setSortResults] = useState([]);
  const [toastActive, setToastActive] = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const [toastError, setToastError] = useState(false);
  const [currentlySorting, setCurrentlySorting] = useState(null);

  const filtered = collections.filter((c) =>
    c.title.toLowerCase().includes(search.toLowerCase())
  );

  const formatDate = (iso) => {
    if (!iso) return null;
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  const toggleSelect = useCallback((id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelected(new Set(filtered.map((c) => c.id)));
  }, [filtered]);

  const deselectAll = useCallback(() => {
    setSelected(new Set());
  }, []);

  // Process sort queue one at a time
  const processQueue = useCallback(async (queue, results = []) => {
    if (queue.length === 0) {
      // All done
      setSorting(false);
      setCurrentlySorting(null);
      setSortQueue([]);
      const succeeded = results.filter((r) => r.success).length;
      const failed = results.filter((r) => !r.success).length;
      setSortResults(results);
      setToastMessage(
        failed === 0
          ? `✓ ${succeeded} collection${succeeded !== 1 ? "s" : ""} sorted successfully!`
          : `${succeeded} sorted, ${failed} failed`
      );
      setToastError(failed > 0);
      setToastActive(true);
      setSelected(new Set());
      return;
    }

    const [current, ...remaining] = queue;
    setCurrentlySorting(current.id);
    setSortProgress((prev) => ({ ...prev, done: prev.total - remaining.length - 1 }));

    const fd = new FormData();
    fd.set("collectionId", current.id);
    fd.set("collectionTitle", current.title);

    try {
      const response = await fetch(window.location.pathname + window.location.search, {
        method: "POST",
        body: fd,
      });
      const result = await response.json();
      const newResults = [...results, { ...result, title: current.title }];
      setSortProgress((prev) => ({ ...prev, done: prev.total - remaining.length }));
      await processQueue(remaining, newResults);
    } catch (err) {
      const newResults = [...results, { success: false, title: current.title, message: err.message }];
      setSortProgress((prev) => ({ ...prev, done: prev.total - remaining.length }));
      await processQueue(remaining, newResults);
    }
  }, []);

  const handleBulkSort = useCallback(async () => {
    const toSort = collections.filter((c) => selected.has(c.id));
    if (toSort.length === 0) return;

    setSorting(true);
    setSortResults([]);
    setSortProgress({ done: 0, total: toSort.length });
    setSortQueue(toSort);

    await processQueue(toSort);
  }, [selected, collections, processQueue]);

  const selectedCount = selected.size;

  return (
    <Frame>
      <Page
        title="Collections"
        subtitle={`${collections.length} collections in your store`}
      >
        <Layout>
          {/* Bulk sort controls */}
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <InlineStack gap="300" blockAlign="center">
                    <Text variant="headingMd" as="h2">Bulk Sort</Text>
                    {selectedCount > 0 && (
                      <Badge tone="info">{selectedCount} selected</Badge>
                    )}
                  </InlineStack>
                  <InlineStack gap="200">
                    <Button size="slim" onClick={selectAll} disabled={sorting}>
                      Select All
                    </Button>
                    <Button size="slim" onClick={deselectAll} disabled={sorting || selectedCount === 0}>
                      Deselect All
                    </Button>
                    <Button
                      variant="primary"
                      icon={SortIcon}
                      disabled={selectedCount === 0 || sorting}
                      loading={sorting}
                      onClick={handleBulkSort}
                    >
                      {sorting
                        ? `Sorting ${sortProgress.done} of ${sortProgress.total}…`
                        : `Sort ${selectedCount > 0 ? selectedCount : ""} Selected`}
                    </Button>
                  </InlineStack>
                </InlineStack>

                {sorting && (
                  <BlockStack gap="200">
                    <ProgressBar
                      progress={sortProgress.total > 0 ? (sortProgress.done / sortProgress.total) * 100 : 0}
                      size="small"
                      tone="success"
                    />
                    {currentlySorting && (
                      <Text variant="bodySm" tone="subdued">
                        Sorting: {collections.find((c) => c.id === currentlySorting)?.title}…
                      </Text>
                    )}
                  </BlockStack>
                )}

                {!sorting && sortResults.length > 0 && (
                  <BlockStack gap="100">
                    <Divider />
                    <Text variant="bodySm" fontWeight="semibold">Last bulk sort results:</Text>
                    {sortResults.map((r, i) => (
                      <InlineStack key={i} gap="200" blockAlign="center">
                        <Text variant="bodySm" tone={r.success ? "success" : "critical"}>
                          {r.success ? "✓" : "✗"} {r.title}
                          {r.success ? ` — ${r.productCount} products sorted${r.featuredCount > 0 ? `, ${r.featuredCount} featured` : ""}` : `: ${r.message}`}
                        </Text>
                      </InlineStack>
                    ))}
                  </BlockStack>
                )}

                <Text variant="bodySm" tone="subdued">
                  Select collections below and click Sort Selected to apply inventory-based sort order to all of them at once. Featured products saved per collection will be pinned to the top.
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* Search */}
          <Layout.Section>
            <Card>
              <TextField
                label=""
                placeholder="Search collections…"
                value={search}
                onChange={setSearch}
                clearButton
                onClearButtonClick={() => setSearch("")}
                autoComplete="off"
              />
            </Card>
          </Layout.Section>

          {filtered.length === 0 && (
            <Layout.Section>
              <EmptyState
                heading="No collections match your search"
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>Try a different search term.</p>
              </EmptyState>
            </Layout.Section>
          )}

          {/* Collections list */}
          <Layout.Section>
            <BlockStack gap="200">
              {filtered.map((col) => {
                const lastSorted = col.settings?.last_sorted_at;
                const isManual = col.sortOrder === "MANUAL";
                const isSelected = selected.has(col.id);
                const isCurrentlySorting = currentlySorting === col.id;

                return (
                  <div
                    key={col.id}
                    style={{
                      border: isSelected ? "2px solid #008060" : "1px solid #e1e1e1",
                      borderRadius: 8,
                      background: isSelected ? "#f0faf7" : "white",
                      transition: "all 0.15s ease",
                    }}
                  >
                    <Box padding="300">
                      <InlineStack align="space-between" blockAlign="center" gap="400">
                        <InlineStack gap="300" blockAlign="center">
                          <Checkbox
                            label=""
                            labelHidden
                            checked={isSelected}
                            onChange={() => toggleSelect(col.id)}
                            disabled={sorting}
                          />
                          {col.image ? (
                            <Thumbnail
                              source={col.image.url}
                              alt={col.image.altText || col.title}
                              size="small"
                            />
                          ) : (
                            <div style={{
                              width: 40, height: 40, background: "#f4f4f4",
                              borderRadius: 6, display: "flex", alignItems: "center",
                              justifyContent: "center", fontSize: 20,
                            }}>
                              📁
                            </div>
                          )}
                          <BlockStack gap="100">
                            <InlineStack gap="200" blockAlign="center">
                              <Text variant="headingSm" as="h3">{col.title}</Text>
                              {isCurrentlySorting && (
                                <Badge tone="attention" progress="partiallyComplete">Sorting…</Badge>
                              )}
                            </InlineStack>
                            <InlineStack gap="200">
                              <Text variant="bodySm" tone="subdued">
                                {col.productsCount} products
                              </Text>
                              {isManual ? (
                                <Badge tone="success" size="small">Manual sort</Badge>
                              ) : (
                                <Badge tone="warning" size="small">{col.sortOrder || "Auto"}</Badge>
                              )}
                              {lastSorted ? (
                                <Badge tone="info" size="small">
                                  Sorted {formatDate(lastSorted)}
                                </Badge>
                              ) : (
                                <Badge tone="attention" size="small">Never sorted</Badge>
                              )}
                            </InlineStack>
                          </BlockStack>
                        </InlineStack>

                        <Button
                          size="slim"
                          disabled={sorting}
                          onClick={() => {
                            navigate(`/app/collection?id=${encodeURIComponent(col.id)}`);
                          }}
                        >
                          Manage Featured
                        </Button>
                      </InlineStack>
                    </Box>
                  </div>
                );
              })}
            </BlockStack>
          </Layout.Section>
        </Layout>
      </Page>

      {toastActive && (
        <Toast
          content={toastMessage}
          error={toastError}
          onDismiss={() => setToastActive(false)}
          duration={5000}
        />
      )}
    </Frame>
  );
}
