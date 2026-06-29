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

-- Sort schedules: per-shop schedule configuration
CREATE TABLE IF NOT EXISTS sort_schedules (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  shop_domain TEXT NOT NULL UNIQUE,
  enabled BOOLEAN DEFAULT FALSE,
  run_hour INTEGER DEFAULT 2,         -- UTC hour to run (0-23)
  collection_ids TEXT[] DEFAULT '{}', -- array of collection GIDs to sort
  last_run_at TIMESTAMPTZ,
  last_run_status TEXT,               -- 'success', 'partial', 'error'
  last_run_summary TEXT,              -- human-readable result
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sort_schedules_shop_idx ON sort_schedules(shop_domain);
CREATE INDEX IF NOT EXISTS sort_schedules_enabled_idx ON sort_schedules(enabled);

-- v5: OOS-only mode columns on collection_sort_settings
ALTER TABLE collection_sort_settings
  ADD COLUMN IF NOT EXISTS oos_only_mode BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS position_snapshot JSONB DEFAULT '{}';
-- v6: Shop settings for location-based inventory
CREATE TABLE IF NOT EXISTS shop_settings (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  shop_domain TEXT NOT NULL UNIQUE,
  selected_location_ids TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS shop_settings_shop_idx ON shop_settings(shop_domain);

-- Enable Row Level Security on all tables.
-- The app uses the Supabase service_role key, which bypasses RLS automatically.
-- This blocks public/anonymous access while leaving the app fully functional.
ALTER TABLE shopify_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_sort_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE featured_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE sort_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_settings ENABLE ROW LEVEL SECURITY;
