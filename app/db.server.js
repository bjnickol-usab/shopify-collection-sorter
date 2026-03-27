import { createClient } from "@supabase/supabase-js";
import { Session } from "@shopify/shopify-api";

// ─── Supabase Client ──────────────────────────────────────────────────────────

const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!supabaseUrl || !supabaseKey) {
  console.error("WARNING: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

export const supabase = createClient(supabaseUrl, supabaseKey);

// ─── Shopify Session Storage (Supabase-backed) ────────────────────────────────

export const sessionStorage = {
  async storeSession(session) {
    const { error } = await supabase.from("shopify_sessions").upsert({
      id: session.id,
      shop: session.shop,
      state: session.state,
      is_online: session.isOnline,
      scope: session.scope,
      expires: session.expires?.toISOString() ?? null,
      access_token: session.accessToken ?? null,
      user_id: session.onlineAccessInfo?.associated_user?.id ?? null,
      first_name: session.onlineAccessInfo?.associated_user?.first_name ?? null,
      last_name: session.onlineAccessInfo?.associated_user?.last_name ?? null,
      email: session.onlineAccessInfo?.associated_user?.email ?? null,
      account_owner: session.onlineAccessInfo?.associated_user?.account_owner ?? null,
      locale: session.onlineAccessInfo?.associated_user?.locale ?? null,
      collaborator: session.onlineAccessInfo?.associated_user?.collaborator ?? null,
      email_verified: session.onlineAccessInfo?.associated_user?.email_verified ?? null,
    });
    if (error) throw new Error(`Failed to store session: ${error.message}`);
    return true;
  },

  async loadSession(id) {
    try {
      const { data, error } = await supabase
        .from("shopify_sessions")
        .select("*")
        .eq("id", id)
        .single();
      if (error || !data) return undefined;
      return buildSessionObject(data);
    } catch {
      return undefined;
    }
  },

  async deleteSession(id) {
    const { error } = await supabase
      .from("shopify_sessions")
      .delete()
      .eq("id", id);
    if (error) throw new Error(`Failed to delete session: ${error.message}`);
    return true;
  },

  async deleteSessions(ids) {
    const { error } = await supabase
      .from("shopify_sessions")
      .delete()
      .in("id", ids);
    if (error) throw new Error(`Failed to delete sessions: ${error.message}`);
    return true;
  },

  async findSessionsByShop(shop) {
    const { data, error } = await supabase
      .from("shopify_sessions")
      .select("*")
      .eq("shop", shop);
    if (error) return [];
    return data.map(buildSessionObject);
  },
};

// Build a proper Session instance so methods like isActive() work
function buildSessionObject(data) {
  const session = new Session({
    id: data.id,
    shop: data.shop,
    state: data.state,
    isOnline: data.is_online,
  });
  session.scope = data.scope;
  session.expires = data.expires ? new Date(data.expires) : undefined;
  session.accessToken = data.access_token;
  return session;
}

// ─── Featured Products ────────────────────────────────────────────────────────

export async function getFeaturedProducts(shopDomain, collectionId) {
  const { data, error } = await supabase
    .from("featured_products")
    .select("*")
    .eq("shop_domain", shopDomain)
    .eq("collection_id", collectionId)
    .order("position", { ascending: true });

  if (error) throw new Error(`Failed to get featured products: ${error.message}`);
  return data || [];
}

export async function setFeaturedProducts(shopDomain, collectionId, products) {
  const { error: deleteError } = await supabase
    .from("featured_products")
    .delete()
    .eq("shop_domain", shopDomain)
    .eq("collection_id", collectionId);

  if (deleteError) throw new Error(`Failed to clear featured products: ${deleteError.message}`);
  if (products.length === 0) return [];

  const rows = products.map((p, i) => ({
    shop_domain: shopDomain,
    collection_id: collectionId,
    product_id: p.product_id,
    product_title: p.product_title,
    position: i + 1,
  }));

  const { data, error } = await supabase
    .from("featured_products")
    .insert(rows)
    .select();

  if (error) throw new Error(`Failed to set featured products: ${error.message}`);
  return data;
}

export async function addFeaturedProduct(shopDomain, collectionId, productId, productTitle) {
  const { data: existing } = await supabase
    .from("featured_products")
    .select("position")
    .eq("shop_domain", shopDomain)
    .eq("collection_id", collectionId)
    .order("position", { ascending: false })
    .limit(1);

  const nextPosition = existing && existing.length > 0 ? existing[0].position + 1 : 1;

  const { error } = await supabase.from("featured_products").upsert({
    shop_domain: shopDomain,
    collection_id: collectionId,
    product_id: productId,
    product_title: productTitle,
    position: nextPosition,
  });

  if (error) throw new Error(`Failed to add featured product: ${error.message}`);
  return true;
}

export async function removeFeaturedProduct(shopDomain, collectionId, productId) {
  const { error } = await supabase
    .from("featured_products")
    .delete()
    .eq("shop_domain", shopDomain)
    .eq("collection_id", collectionId)
    .eq("product_id", productId);

  if (error) throw new Error(`Failed to remove featured product: ${error.message}`);

  const { data } = await supabase
    .from("featured_products")
    .select("id")
    .eq("shop_domain", shopDomain)
    .eq("collection_id", collectionId)
    .order("position", { ascending: true });

  if (data) {
    for (let i = 0; i < data.length; i++) {
      await supabase
        .from("featured_products")
        .update({ position: i + 1 })
        .eq("id", data[i].id);
    }
  }

  return true;
}

// ─── Collection Sort Settings ─────────────────────────────────────────────────

export async function getCollectionSortSettings(shopDomain, collectionId) {
  const { data } = await supabase
    .from("collection_sort_settings")
    .select("*")
    .eq("shop_domain", shopDomain)
    .eq("collection_id", collectionId)
    .single();

  return data || null;
}

export async function getAllCollectionSettings(shopDomain) {
  const { data } = await supabase
    .from("collection_sort_settings")
    .select("*")
    .eq("shop_domain", shopDomain);

  return data || [];
}

export async function updateCollectionSortedAt(shopDomain, collectionId, collectionTitle) {
  const { error } = await supabase.from("collection_sort_settings").upsert({
    shop_domain: shopDomain,
    collection_id: collectionId,
    collection_title: collectionTitle,
    last_sorted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  if (error) throw new Error(`Failed to update sort timestamp: ${error.message}`);
  return true;
}
