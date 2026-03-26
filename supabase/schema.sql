-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Shopify session storage (required for OAuth)
CREATE TABLE IF NOT EXISTS shopify_sessions (
  id TEXT PRIMARY KEY,
  shop TEXT NOT NULL,
  state TEXT,
  is_online BOOLEAN DEFAULT FALSE,
  scope TEXT,
  expires TIMESTAMPTZ,
  access_token TEXT,
  user_id BIGINT,
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  account_owner BOOLEAN,
  locale TEXT,
  collaborator BOOLEAN,
  email_verified BOOLEAN
);

CREATE INDEX IF NOT EXISTS shopify_sessions_shop_idx ON shopify_sessions(shop);

-- Collection sort settings: per-shop, per-collection configuration
CREATE TABLE IF NOT EXISTS collection_sort_settings (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  shop_domain TEXT NOT NULL,
  collection_id TEXT NOT NULL,        -- Shopify collection GID (gid://shopify/Collection/...)
  collection_title TEXT,
  last_sorted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(shop_domain, collection_id)
);

CREATE INDEX IF NOT EXISTS collection_sort_settings_shop_idx ON collection_sort_settings(shop_domain);

-- Featured products: which products are pinned to the top per collection
CREATE TABLE IF NOT EXISTS featured_products (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  shop_domain TEXT NOT NULL,
  collection_id TEXT NOT NULL,         -- Shopify collection GID
  product_id TEXT NOT NULL,            -- Shopify product GID
  product_title TEXT,
  position INTEGER NOT NULL DEFAULT 1, -- 1 = first featured slot
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(shop_domain, collection_id, product_id)
);

CREATE INDEX IF NOT EXISTS featured_products_collection_idx ON featured_products(shop_domain, collection_id);
