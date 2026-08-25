import { json } from "@remix-run/node";
import { useLoaderData, useNavigate, useFetcher } from "@remix-run/react";
import { useState, useCallback, useEffect, useRef } from "react";
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
  Divider,
  Toast,
  Frame,
  Box,
  ProgressBar,
} from "@shopify/polaris";
import { SortIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server.js";
import { getAllCollectionSettings } from "../db.server.js";

const GET_COLLECTIONS = `
  query GetCollections($first: Int!, $after: String) {
    collections(first: $first, after: $after) {
      edges {
        node {
          id
          title
          productsCount { count }
          sortOrder
          image { url altText }
        }
        cursor
      }
      pageInfo { hasNextPage endCursor }
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
  const settingsMap = Object.fromEntries(sortSettings.map((s) => [s.collection_id, s]));

  return json({
    collections: all.map((col) => ({
      ...col,
      productsCount: col.productsCount?.count ?? 0,
      settings: settingsMap[col.id] || null,
    })).sort((a, b) => a.title.localeCompare(b.title)),
  });
}

export default function CollectionsList() {
  const { collections } = useLoaderData();
  const navigate = useNavigate();
  const fetcher = useFetcher();

  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(new Set());
  const [sorting, setSorting] = useState(false);
  const [sortQueue, setSortQueue] = useState([]);
  const [sortDone, setSortDone] = useState(0);
  const [sortTotal, setSortTotal] = useState(0);
  const [currentTitle, setCurrentTitle] = useState("");
  const [sortResults, setSortResults] = useState([]);
  const [toastActive, setToastActive] = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const [toastError, setToastError] = useState(false);
  const [localSettings, setLocalSettings] = useState(() =>
    Object.fromEntries(collections.map((c) => [c.id, c.settings]))
  );

  const queueRef = useRef([]);
  const resultsRef = useRef([]);

  const filtered = collections.filter((c) =>
    c.title.toLowerCase().includes(search.toLowerCase())
  );

  const formatDate = (iso) => {
    if (!iso) return null;
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };

  const toggleSelect = useCallback((id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const selectAll = () => setSelected(new Set(filtered.map((c) => c.id)));
  const deselectAll = () => setSelected(new Set());

  // Watch fetcher for completed sort and advance queue
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data && sorting) {
      const result = fetcher.data;
      resultsRef.current = [...resultsRef.current, {
        ...result,
        title: queueRef.current[0]?.title || "",
      }];

      // Update local last-sorted timestamp
      if (result.success && result.collectionId) {
        setLocalSettings((prev) => ({
          ...prev,
          [result.collectionId]: { last_sorted_at: new Date().toISOString() },
        }));
      }

      // Advance queue
      const remaining = queueRef.current.slice(1);
      queueRef.current = remaining;

      if (remaining.length === 0) {
        // All done
        setSorting(false);
        setCurrentTitle("");
        setSortDone(resultsRef.current.length);
        setSortResults(resultsRef.current);
        const succeeded = resultsRef.current.filter((r) => r.success).length;
        const failed = resultsRef.current.filter((r) => !r.success).length;
        setToastMessage(
          failed === 0
            ? `✓ ${succeeded} collection${succeeded !== 1 ? "s" : ""} sorted!`
            : `${succeeded} sorted, ${failed} failed`
        );
        setToastError(failed > 0);
        setToastActive(true);
        setSelected(new Set());
      } else {
        // Submit next
        const next = remaining[0];
        setSortDone((d) => d + 1);
        setCurrentTitle(next.title);
        const fd = new FormData();
        fd.set("collectionId", next.id);
        fd.set("collectionTitle", next.title);
        fetcher.submit(fd, { method: "post", action: "/api/bulk-sort" });
      }
    }
  }, [fetcher.state, fetcher.data]);

  const handleBulkSort = useCallback(() => {
    const toSort = collections.filter((c) => selected.has(c.id));
    if (toSort.length === 0) return;

    queueRef.current = toSort;
    resultsRef.current = [];
    setSorting(true);
    setSortResults([]);
    setSortDone(0);
    setSortTotal(toSort.length);
    setCurrentTitle(toSort[0].title);

    const fd = new FormData();
    fd.set("collectionId", toSort[0].id);
    fd.set("collectionTitle", toSort[0].title);
    fetcher.submit(fd, { method: "post", action: "/api/bulk-sort" });
  }, [selected, collections, fetcher]);

  const selectedCount = selected.size;
  const progressPct = sortTotal > 0 ? (sortDone / sortTotal) * 100 : 0;

  return (
    <Frame>
      <Page title="Collections" subtitle={`${collections.length} collections in your store`}>
        <Layout>

          {/* Bulk sort card */}
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <InlineStack gap="200" blockAlign="center">
                    <Text variant="headingMd" as="h2">Bulk Sort</Text>
                    {selectedCount > 0 && <Badge tone="info">{selectedCount} selected</Badge>}
                  </InlineStack>
                  <InlineStack gap="200">
                    <Button size="slim" onClick={selectAll} disabled={sorting}>Select All</Button>
                    <Button size="slim" onClick={deselectAll} disabled={sorting || selectedCount === 0}>Deselect All</Button>
                    <Button
                      variant="primary"
                      icon={SortIcon}
                      disabled={selectedCount === 0 || sorting}
                      loading={sorting}
                      onClick={handleBulkSort}
                    >
                      {sorting ? `Sorting ${sortDone + 1} of ${sortTotal}…` : `Sort ${selectedCount > 0 ? `${selectedCount} ` : ""}Selected`}
                    </Button>
                  </InlineStack>
                </InlineStack>

                {sorting && (
                  <BlockStack gap="100">
                    <ProgressBar progress={progressPct} size="small" tone="success" />
                    <Text variant="bodySm" tone="subdued">Sorting: {currentTitle}…</Text>
                  </BlockStack>
                )}

                {!sorting && sortResults.length > 0 && (
                  <BlockStack gap="100">
                    <Divider />
                    <Text variant="bodySm" fontWeight="semibold">Last bulk sort results:</Text>
                    {sortResults.map((r, i) => (
                      <Text key={i} variant="bodySm" tone={r.success ? "success" : "critical"}>
                        {r.success ? "✓" : "✗"} {r.title}
                        {r.success
                          ? ` — ${r.productCount} products sorted${r.featuredCount > 0 ? `, ${r.featuredCount} featured` : ""}`
                          : `: ${r.message}`}
                      </Text>
                    ))}
                  </BlockStack>
                )}

                <Text variant="bodySm" tone="subdued">
                  Check collections below then click Sort Selected. Featured products saved per collection will be pinned to the top automatically.
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
              <EmptyState heading="No collections match" image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png">
                <p>Try a different search term.</p>
              </EmptyState>
            </Layout.Section>
          )}

          {/* Collection rows */}
          <Layout.Section>
            <BlockStack gap="200">
              {filtered.map((col) => {
                const settings = localSettings[col.id];
                const lastSorted = settings?.last_sorted_at;
                const isManual = col.sortOrder === "MANUAL";
                const isSelected = selected.has(col.id);
                const isCurrentlySorting = sorting && currentTitle === col.title;

                return (
                  <div
                    key={col.id}
                    style={{
                      border: isSelected ? "2px solid #008060" : "1px solid #e1e1e1",
                      borderRadius: 8,
                      background: isSelected ? "#f0faf7" : "white",
                      transition: "border-color 0.15s, background 0.15s",
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
                            <Thumbnail source={col.image.url} alt={col.image.altText || col.title} size="small" />
                          ) : (
                            <div style={{ width: 40, height: 40, background: "#f4f4f4", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>📁</div>
                          )}
                          <BlockStack gap="100">
                            <InlineStack gap="200" blockAlign="center">
                              <Text variant="headingSm" as="h3">{col.title}</Text>
                              {isCurrentlySorting && <Badge tone="attention" progress="partiallyComplete">Sorting…</Badge>}
                            </InlineStack>
                            <InlineStack gap="200">
                              <Text variant="bodySm" tone="subdued">{col.productsCount} products</Text>
                              {isManual
                                ? <Badge tone="success" size="small">Manual sort</Badge>
                                : <Badge tone="warning" size="small">{col.sortOrder || "Auto"}</Badge>
                              }
                              {lastSorted
                                ? <Badge tone="info" size="small">Sorted {formatDate(lastSorted)}</Badge>
                                : <Badge tone="attention" size="small">Never sorted</Badge>
                              }
                            </InlineStack>
                          </BlockStack>
                        </InlineStack>

                        <Button
                          size="slim"
                          disabled={sorting}
                          onClick={() => navigate(`/app/collection?id=${encodeURIComponent(col.id)}`)}
                        >
                          Manage
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
        <Toast content={toastMessage} error={toastError} onDismiss={() => setToastActive(false)} duration={5000} />
      )}
    </Frame>
  );
}
