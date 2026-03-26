export async function loader() {
  const checks = {
    SHOPIFY_API_KEY: !!process.env.SHOPIFY_API_KEY,
    SHOPIFY_API_SECRET: !!process.env.SHOPIFY_API_SECRET,
    SHOPIFY_APP_URL: process.env.SHOPIFY_APP_URL || "MISSING",
    SUPABASE_URL: !!process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    SESSION_SECRET: !!process.env.SESSION_SECRET,
  };

  let shopifyOk = false;
  let shopifyError = null;
  try {
    const { authenticate } = await import("../shopify.server.js");
    shopifyOk = !!authenticate;
  } catch (e) {
    shopifyError = e.message;
  }

  let supabaseOk = false;
  let supabaseError = null;
  try {
    const { supabase } = await import("../db.server.js");
    supabaseOk = !!supabase;
  } catch (e) {
    supabaseError = e.message;
  }

  return new Response(
    JSON.stringify({ envVars: checks, shopifyOk, shopifyError, supabaseOk, supabaseError }, null, 2),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
