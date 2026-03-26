import { json } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import { useState } from "react";
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
} from "@shopify/polaris";
import { authenticate } from "../shopify.server.js";
import { getAllCollectionSettings } from "../db.server.js";

const GET_COLLECTIONS = `
  query GetCollections($first: Int!, $after: String) {
    collections(first: $first, after: $after) {
      edges {
        node {
          id
          title
          productsCount
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
    settings: settingsMap[col.id] || null,
  }));

  return json({ collections: enriched });
}

export default function CollectionsList() {
  const { collections } = useLoaderData();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");

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

  return (
    <Page
      title="Collections"
      subtitle={`${collections.length} collections in your store`}
    >
      <Layout>
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

        <Layout.Section>
          <BlockStack gap="300">
            {filtered.map((col) => {
              const lastSorted = col.settings?.last_sorted_at;
              const isManual = col.sortOrder === "MANUAL";

              return (
                <Card key={col.id}>
                  <InlineStack align="space-between" blockAlign="center" gap="400">
                    <InlineStack gap="300" blockAlign="center">
                      {col.image ? (
                        <Thumbnail
                          source={col.image.url}
                          alt={col.image.altText || col.title}
                          size="small"
                        />
                      ) : (
                        <div
                          style={{
                            width: 40,
                            height: 40,
                            background: "#f4f4f4",
                            borderRadius: 6,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: 20,
                          }}
                        >
                          📁
                        </div>
                      )}
                      <BlockStack gap="100">
                        <Text variant="headingSm" as="h3">
                          {col.title}
                        </Text>
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
                      onClick={() => {
                        navigate(
                          `/app/collections/${encodeURIComponent(col.id)}`
                        );
                      }}
                    >
                      Manage Sort
                    </Button>
                  </InlineStack>
                </Card>
              );
            })}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
