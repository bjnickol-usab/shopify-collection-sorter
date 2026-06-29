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
  Divider,
  Toast,
  Frame,
  Box,
  Thumbnail,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server.js";
import { getShopSettings, saveShopSettings } from "../db.server.js";

const GET_LOCATIONS = `
  query GetLocations {
    locations(first: 50, includeInactive: false) {
      edges {
        node {
          id
          name
          address {
            city
            provinceCode
            countryCode
          }
          fulfillsOnlineOrders
          isActive
        }
      }
    }
  }
`;

export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const response = await admin.graphql(GET_LOCATIONS);
  const { data } = await response.json();
  const locations = data?.locations?.edges?.map((e) => e.node) || [];

  const settings = await getShopSettings(shopDomain);

  return json({
    locations,
    selectedLocationIds: settings?.selected_location_ids || [],
    shopDomain,
  });
}

export async function action({ request }) {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const formData = await request.formData();
  const selectedLocationIds = formData.getAll("locationIds");

  try {
    await saveShopSettings(shopDomain, { selectedLocationIds });
    return json({
      success: true,
      message: selectedLocationIds.length > 0
        ? `Saved — inventory will be checked at ${selectedLocationIds.length} location${selectedLocationIds.length !== 1 ? "s" : ""}.`
        : "Saved — using total inventory across all locations.",
    });
  } catch (error) {
    return json({ success: false, message: error.message });
  }
}

export default function SettingsPage() {
  const { locations, selectedLocationIds: savedIds } = useLoaderData();
  const fetcher = useFetcher();

  const [selected, setSelected] = useState(new Set(savedIds));
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

  const toggleLocation = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleSave = () => {
    const fd = new FormData();
    selected.forEach((id) => fd.append("locationIds", id));
    fetcher.submit(fd, { method: "post" });
  };

  const onlineFulfillmentLocations = locations.filter((l) => l.fulfillsOnlineOrders);
  const otherLocations = locations.filter((l) => !l.fulfillsOnlineOrders);

  const formatAddress = (loc) => {
    const parts = [loc.address?.city, loc.address?.provinceCode, loc.address?.countryCode].filter(Boolean);
    return parts.join(", ");
  };

  return (
    <Frame>
      <Page
        title="Inventory Settings"
        subtitle="Choose which locations count toward in-stock status"
        primaryAction={{
          content: isSaving ? "Saving…" : "Save Settings",
          loading: isSaving,
          disabled: isSaving,
          onAction: handleSave,
        }}
      >
        <Layout>
          <Layout.Section>
            <Banner title="How location-based inventory works" tone="info">
              <p>
                By default, the app uses each product's total inventory across <strong>all locations</strong>.
                If you select specific locations below, a product is only considered <strong>in stock</strong>
                if it has available inventory at one or more of your selected locations.
                This is useful if you have warehouse or retail locations that shouldn't affect
                your online store's sort order.
              </p>
              {selected.size === 0 && (
                <p style={{ marginTop: 8 }}>
                  <strong>Currently using total inventory</strong> (no locations selected).
                </p>
              )}
            </Banner>
          </Layout.Section>

          {/* Online fulfillment locations */}
          {onlineFulfillmentLocations.length > 0 && (
            <Layout.Section>
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <BlockStack gap="100">
                      <Text variant="headingMd" as="h2">
                        Online Fulfillment Locations
                      </Text>
                      <Text variant="bodySm" tone="subdued">
                        These locations are set up to fulfill online orders in Shopify.
                      </Text>
                    </BlockStack>
                    <Button
                      size="slim"
                      onClick={() => setSelected(new Set(onlineFulfillmentLocations.map((l) => l.id)))}
                    >
                      Select All Online
                    </Button>
                  </InlineStack>

                  <BlockStack gap="150">
                    {onlineFulfillmentLocations.map((loc) => {
                      const isSelected = selected.has(loc.id);
                      return (
                        <div
                          key={loc.id}
                          style={{
                            border: isSelected ? "2px solid #008060" : "1px solid #e1e1e1",
                            borderRadius: 8,
                            background: isSelected ? "#f0faf7" : "white",
                            transition: "all 0.15s",
                          }}
                        >
                          <Box padding="300">
                            <InlineStack gap="300" blockAlign="center">
                              <Checkbox
                                label=""
                                labelHidden
                                checked={isSelected}
                                onChange={() => toggleLocation(loc.id)}
                              />
                              <BlockStack gap="050">
                                <InlineStack gap="200" blockAlign="center">
                                  <Text variant="bodyMd" fontWeight="semibold">{loc.name}</Text>
                                  <Badge tone="success" size="small">Online fulfillment</Badge>
                                </InlineStack>
                                {formatAddress(loc) && (
                                  <Text variant="bodySm" tone="subdued">{formatAddress(loc)}</Text>
                                )}
                              </BlockStack>
                            </InlineStack>
                          </Box>
                        </div>
                      );
                    })}
                  </BlockStack>
                </BlockStack>
              </Card>
            </Layout.Section>
          )}

          {/* Other locations */}
          {otherLocations.length > 0 && (
            <Layout.Section>
              <Card>
                <BlockStack gap="300">
                  <BlockStack gap="100">
                    <Text variant="headingMd" as="h2">Other Locations</Text>
                    <Text variant="bodySm" tone="subdued">
                      These locations are not configured for online order fulfillment in Shopify.
                      You can still include them if needed.
                    </Text>
                  </BlockStack>

                  <BlockStack gap="150">
                    {otherLocations.map((loc) => {
                      const isSelected = selected.has(loc.id);
                      return (
                        <div
                          key={loc.id}
                          style={{
                            border: isSelected ? "2px solid #008060" : "1px solid #e1e1e1",
                            borderRadius: 8,
                            background: isSelected ? "#f0faf7" : "#fafafa",
                            transition: "all 0.15s",
                          }}
                        >
                          <Box padding="300">
                            <InlineStack gap="300" blockAlign="center">
                              <Checkbox
                                label=""
                                labelHidden
                                checked={isSelected}
                                onChange={() => toggleLocation(loc.id)}
                              />
                              <BlockStack gap="050">
                                <InlineStack gap="200" blockAlign="center">
                                  <Text variant="bodyMd" fontWeight="semibold">{loc.name}</Text>
                                  <Badge tone="subdued" size="small">Not online fulfillment</Badge>
                                </InlineStack>
                                {formatAddress(loc) && (
                                  <Text variant="bodySm" tone="subdued">{formatAddress(loc)}</Text>
                                )}
                              </BlockStack>
                            </InlineStack>
                          </Box>
                        </div>
                      );
                    })}
                  </BlockStack>
                </BlockStack>
              </Card>
            </Layout.Section>
          )}

          {/* Current selection summary */}
          <Layout.Section>
            <Card>
              <BlockStack gap="200">
                <Text variant="headingSm" as="h3">Current Selection</Text>
                {selected.size === 0 ? (
                  <Text variant="bodySm" tone="subdued">
                    No locations selected — using total inventory across all locations.
                    A product is in stock if it has any inventory anywhere.
                  </Text>
                ) : (
                  <Text variant="bodySm" tone="subdued">
                    {selected.size} location{selected.size !== 1 ? "s" : ""} selected.
                    A product is considered in stock only if it has available inventory
                    at one or more of these locations.
                  </Text>
                )}
                {selected.size > 0 && (
                  <Button size="slim" variant="plain" tone="critical" onClick={() => setSelected(new Set())}>
                    Clear all selections (use total inventory)
                  </Button>
                )}
              </BlockStack>
            </Card>
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
