import { json } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  Button,
  InlineStack,
  Badge,
  EmptyState,
  DataTable,
  Thumbnail,
  Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server.js";
import { getAllCollectionSettings } from "../db.server.js";

// ─── GraphQL: fetch all collections ──────────────────────────────────────────

const GET_COLLECTIONS = `
  query GetCollections($first: Int!) {
    collections(first: $first) {
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
      }
    }
  }
`;

export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const response = await admin.graphql(GET_COLLECTIONS, {
    variables: { first: 50 },
  });
  const { data } = await response.json();
  const collections = data?.collections?.edges?.map((e) => e.node) || [];

  const sortSettings = await getAllCollectionSettings(shopDomain);
  const settingsMap = Object.fromEntries(
    sortSettings.map((s) => [s.collection_id, s])
  );

  const enriched = collections.map((col) => ({
    ...col,
    productsCount: col.productsCount?.count ?? 0,
    settings: settingsMap[col.id] || null,
  }));

  return json({ collections: enriched, shopDomain });
}

export default function Dashboard() {
  const { collections } = useLoaderData();
  const navigate = useNavigate();

  const sorted = collections.filter((c) => c.settings?.last_sorted_at);
  const unsorted = collections.filter((c) => !c.settings?.last_sorted_at);

  const formatDate = (iso) => {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const rows = collections.map((col) => {
    const lastSorted = col.settings?.last_sorted_at;
    const isManual = col.sortOrder === "MANUAL";
    return [
      <InlineStack gap="200" blockAlign="center" key={col.id}>
        {col.image ? (
          <Thumbnail source={col.image.url} alt={col.image.altText || col.title} size="small" />
        ) : (
          <div style={{ width: 40, height: 40, background: "#f4f4f4", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>📁</div>
        )}
        <Text variant="bodyMd" fontWeight="semibold">{col.title}</Text>
      </InlineStack>,
      <Text variant="bodyMd" key={`count-${col.id}`}>{col.productsCount}</Text>,
      isManual ? (
        <Badge tone="success" key={`sort-${col.id}`}>Manual</Badge>
      ) : (
        <Badge tone="warning" key={`sort-${col.id}`}>{col.sortOrder || "Auto"}</Badge>
      ),
      <Text variant="bodyMd" tone={lastSorted ? undefined : "subdued"} key={`time-${col.id}`}>
        {lastSorted ? formatDate(lastSorted) : "Never sorted"}
      </Text>,
      <Button
        key={`btn-${col.id}`}
        size="slim"
        onClick={() => {
          const encodedId = encodeURIComponent(col.id);
          navigate(`/app/collection?id=${encodedId}`);
        }}
      >
        Manage
      </Button>,
    ];
  });

  return (
    <Page
      title="Collection Sorter"
      subtitle="Sort your Shopify collections by inventory level, with pinned featured products"
      primaryAction={{
        content: "Browse Collections",
        url: "/app/collections",
      }}
    >
      <Layout>
        {collections.length === 0 && (
          <Layout.Section>
            <EmptyState
              heading="No collections found"
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            >
              <p>Create collections in your Shopify admin and then return here to manage their sort order.</p>
            </EmptyState>
          </Layout.Section>
        )}

        {collections.length > 0 && (
          <>
            <Layout.Section>
              <InlineStack gap="500">
                <Card>
                  <BlockStack gap="100">
                    <Text variant="headingXl" as="p">{collections.length}</Text>
                    <Text variant="bodySm" tone="subdued">Total Collections</Text>
                  </BlockStack>
                </Card>
                <Card>
                  <BlockStack gap="100">
                    <Text variant="headingXl" as="p">{sorted.length}</Text>
                    <Text variant="bodySm" tone="subdued">Collections Sorted</Text>
                  </BlockStack>
                </Card>
                <Card>
                  <BlockStack gap="100">
                    <Text variant="headingXl" as="p">{unsorted.length}</Text>
                    <Text variant="bodySm" tone="subdued">Never Sorted</Text>
                  </BlockStack>
                </Card>
              </InlineStack>
            </Layout.Section>

            {unsorted.length > 0 && (
              <Layout.Section>
                <Banner title={`${unsorted.length} collection${unsorted.length > 1 ? "s have" : " has"} never been sorted`} tone="warning">
                  Click <strong>Manage</strong> next to any collection to set featured products, or go to <strong>Collections</strong> to bulk sort multiple at once.
                </Banner>
              </Layout.Section>
            )}

            <Layout.Section>
              <Card>
                <DataTable
                  columnContentTypes={["text", "text", "text", "text", "text"]}
                  headings={["Collection", "Products", "Sort Order", "Last Sorted", ""]}
                  rows={rows}
                />
              </Card>
            </Layout.Section>
          </>
        )}
      </Layout>
    </Page>
  );
}
