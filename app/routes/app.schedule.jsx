import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { useState, useEffect } from "react";
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
  Checkbox,
  Select,
  Divider,
  Toast,
  Frame,
  Thumbnail,
  Box,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server.js";
import { getSchedule, saveSchedule, getAllCollectionSettings } from "../db.server.js";

const GET_COLLECTIONS = `
  query GetCollections($first: Int!, $after: String) {
    collections(first: $first, after: $after) {
      edges {
        node {
          id
          title
          productsCount { count }
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

  // Fetch collections
  let all = [];
  let after = null;
  let hasNextPage = true;
  while (hasNextPage) {
    const response = await admin.graphql(GET_COLLECTIONS, { variables: { first: 50, after } });
    const { data } = await response.json();
    const edges = data?.collections?.edges || [];
    all = all.concat(edges.map((e) => e.node));
    hasNextPage = data?.collections?.pageInfo?.hasNextPage || false;
    after = data?.collections?.pageInfo?.endCursor || null;
    if (edges.length === 0) break;
  }

  const schedule = await getSchedule(shopDomain);
  const sortSettings = await getAllCollectionSettings(shopDomain);
  const settingsMap = Object.fromEntries(sortSettings.map((s) => [s.collection_id, s]));

  return json({
    collections: all.map((c) => ({
      ...c,
      productsCount: c.productsCount?.count ?? 0,
      settings: settingsMap[c.id] || null,
    })),
    schedule,
    shopDomain,
  });
}

export async function action({ request }) {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const formData = await request.formData();
  const enabled = formData.get("enabled") === "true";
  const runHour = parseInt(formData.get("runHour") || "2", 10);
  const collectionIds = formData.getAll("collectionIds");

  try {
    await saveSchedule(shopDomain, { enabled, runHour, collectionIds });
    return json({ success: true, message: enabled ? "Schedule saved and enabled." : "Schedule saved (disabled)." });
  } catch (error) {
    return json({ success: false, message: error.message });
  }
}

// UTC hour options
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => {
  const ampm = i < 12 ? "AM" : "PM";
  const h = i % 12 === 0 ? 12 : i % 12;
  return { label: `${h}:00 ${ampm} UTC`, value: String(i) };
});

export default function SchedulePage() {
  const { collections, schedule, shopDomain } = useLoaderData();
  const fetcher = useFetcher();

  const [enabled, setEnabled] = useState(schedule?.enabled ?? false);
  const [runHour, setRunHour] = useState(String(schedule?.run_hour ?? 2));
  const [selectedCollections, setSelectedCollections] = useState(
    new Set(schedule?.collection_ids ?? [])
  );
  const [toastActive, setToastActive] = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const [toastError, setToastError] = useState(false);

  const isSaving = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      setToastMessage(fetcher.data.message);
      setToastError(!fetcher.data.success);
      setToastActive(true);
    }
  }, [fetcher.state, fetcher.data]);

  const toggleCollection = (id) => {
    setSelectedCollections((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelectedCollections(new Set(collections.map((c) => c.id)));
  const deselectAll = () => setSelectedCollections(new Set());

  const handleSave = () => {
    const fd = new FormData();
    fd.set("enabled", String(enabled));
    fd.set("runHour", runHour);
    selectedCollections.forEach((id) => fd.append("collectionIds", id));
    fetcher.submit(fd, { method: "post" });
  };

  const formatLastRun = (iso) => {
    if (!iso) return "Never";
    return new Date(iso).toLocaleString("en-US", {
      month: "short", day: "numeric", year: "numeric",
      hour: "2-digit", minute: "2-digit", timeZoneName: "short",
    });
  };

  const selectedCount = selectedCollections.size;

  return (
    <Frame>
      <Page
        title="Auto-Sort Schedule"
        subtitle="Automatically sort your collections by inventory every day"
        primaryAction={{
          content: isSaving ? "Saving…" : "Save Schedule",
          loading: isSaving,
          disabled: isSaving,
          onAction: handleSave,
        }}
      >
        <Layout>

          {/* Status card */}
          {schedule && (
            <Layout.Section>
              <Banner
                tone={schedule.enabled ? "success" : "warning"}
                title={schedule.enabled ? "Auto-sort is enabled" : "Auto-sort is disabled"}
              >
                {schedule.enabled ? (
                  <p>
                    Running daily at <strong>{HOUR_OPTIONS[schedule.run_hour]?.label}</strong> on <strong>{schedule.collection_ids?.length ?? 0} collection{schedule.collection_ids?.length !== 1 ? "s" : ""}</strong>.
                    {schedule.last_run_at && (
                      <> Last run: <strong>{formatLastRun(schedule.last_run_at)}</strong>
                        {schedule.last_run_status && (
                          <> — <Badge tone={schedule.last_run_status === "success" ? "success" : schedule.last_run_status === "partial" ? "warning" : "critical"}>
                            {schedule.last_run_status}
                          </Badge></>
                        )}
                      </>
                    )}
                  </p>
                ) : (
                  <p>Enable the schedule below and click Save to activate daily auto-sorting.</p>
                )}
                {schedule.last_run_summary && (
                  <p style={{ marginTop: 4, fontSize: 13, color: "#666" }}>{schedule.last_run_summary}</p>
                )}
              </Banner>
            </Layout.Section>
          )}

          {/* Schedule settings */}
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text variant="headingMd" as="h2">Schedule Settings</Text>

                <Checkbox
                  label="Enable daily auto-sort"
                  helpText="When enabled, selected collections will be automatically sorted every day at the time below."
                  checked={enabled}
                  onChange={setEnabled}
                />

                <Select
                  label="Run time (UTC)"
                  options={HOUR_OPTIONS}
                  value={runHour}
                  onChange={setRunHour}
                  disabled={!enabled}
                  helpText="All times are in UTC. Add or subtract hours based on your timezone."
                />

                <Divider />

                <BlockStack gap="200">
                  <InlineStack align="space-between" blockAlign="center">
                    <BlockStack gap="050">
                      <Text variant="headingSm" as="h3">
                        Collections to auto-sort
                        {selectedCount > 0 && (
                          <> <Badge tone="info">{selectedCount} selected</Badge></>
                        )}
                      </Text>
                      <Text variant="bodySm" tone="subdued">
                        Choose which collections to include in the daily sort.
                      </Text>
                    </BlockStack>
                    <InlineStack gap="200">
                      <Button size="slim" onClick={selectAll} disabled={!enabled}>Select All</Button>
                      <Button size="slim" onClick={deselectAll} disabled={!enabled || selectedCount === 0}>Deselect All</Button>
                    </InlineStack>
                  </InlineStack>

                  <BlockStack gap="150">
                    {collections.map((col) => {
                      const isSelected = selectedCollections.has(col.id);
                      return (
                        <div
                          key={col.id}
                          style={{
                            border: isSelected ? "2px solid #008060" : "1px solid #e1e1e1",
                            borderRadius: 8,
                            background: isSelected ? "#f0faf7" : enabled ? "white" : "#fafafa",
                            opacity: enabled ? 1 : 0.6,
                            transition: "all 0.15s",
                          }}
                        >
                          <Box padding="300">
                            <InlineStack gap="300" blockAlign="center">
                              <Checkbox
                                label=""
                                labelHidden
                                checked={isSelected}
                                onChange={() => toggleCollection(col.id)}
                                disabled={!enabled}
                              />
                              {col.image ? (
                                <Thumbnail source={col.image.url} alt={col.title} size="small" />
                              ) : (
                                <div style={{ width: 40, height: 40, background: "#f4f4f4", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>📁</div>
                              )}
                              <BlockStack gap="050">
                                <Text variant="bodyMd" fontWeight="semibold">{col.title}</Text>
                                <Text variant="bodySm" tone="subdued">{col.productsCount} products</Text>
                              </BlockStack>
                              {col.settings?.last_sorted_at && (
                                <Badge tone="info" size="small">
                                  Last sorted {new Date(col.settings.last_sorted_at).toLocaleDateString()}
                                </Badge>
                              )}
                            </InlineStack>
                          </Box>
                        </div>
                      );
                    })}
                  </BlockStack>
                </BlockStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* How it works */}
          <Layout.Section>
            <Card>
              <BlockStack gap="200">
                <Text variant="headingSm" as="h3">How auto-sort works</Text>
                <Text variant="bodySm" tone="subdued">
                  Once enabled, a scheduled job runs daily at your chosen time. It sorts each selected collection by inventory (highest to lowest), with any featured products you've configured pinned to the top. Sort results are logged so you can see when the last run occurred and whether it succeeded.
                </Text>
                <Text variant="bodySm" tone="subdued">
                  The schedule runs in the background — no action needed from you. You can still manually sort collections at any time from the Collections page.
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>

        </Layout>
      </Page>

      {toastActive && (
        <Toast content={toastMessage} error={toastError} onDismiss={() => setToastActive(false)} duration={4000} />
      )}
    </Frame>
  );
}
