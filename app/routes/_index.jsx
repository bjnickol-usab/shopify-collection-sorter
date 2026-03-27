import { redirect } from "@remix-run/node";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  // Preserve all query params Shopify sends (shop, hmac, host, etc.)
  return redirect("/app" + url.search);
};
