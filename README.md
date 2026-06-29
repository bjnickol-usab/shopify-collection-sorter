# Shopify Collection Sorter

Sort products in any Shopify collection by inventory level (highest → lowest), with the ability to pin "featured" products at the top, demote out-of-stock items, schedule daily auto-sort, and filter inventory by specific fulfillment locations.

## Features

- **Manual sort** — sort any single collection by inventory, with featured products pinned to the top
- **Bulk sort** — select multiple collections and sort them all at once
- **OOS demotion** — featured products that go out of stock automatically move to the bottom
- **OOS-only mode** — optionally only move out-of-stock items to the bottom, leaving everything else in place; items restore to their original position when back in stock
- **Daily auto-sort** — schedule sorting to run automatically once per day via Vercel Cron
- **Location-based inventory** — choose specific Shopify locations (e.g. only your online fulfillment warehouse) to determine in-stock/out-of-stock status, ignoring retail or other locations

---

## Tech Stack

- **Remix** (Shopify App Remix framework)
- **Supabase** (session storage + app data)
- **Vercel** (hosting + cron)
- **GitHub** (source control)

---

## Setup Guide

### Step 1 — Create a Shopify Partner App

1. [partners.shopify.com](https://partners.shopify.com) → **Apps → Create app** → **Create app manually**
2. Name it, note your **Client ID** and **Client Secret**

### Step 2 — Create a Supabase Project

1. [supabase.com](https://supabase.com) → **New Project**
2. **Settings → API** → note your **Project URL** and **service_role** key
3. **SQL Editor** → run the entire contents of `supabase/schema.sql`

### Step 3 — Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
gh repo create shopify-collection-sorter --private --push --source=.
```

### Step 4 — Deploy to Vercel

1. [vercel.com](https://vercel.com) → **New Project** → import your GitHub repo
2. **Framework Preset:** Remix
3. Add Environment Variables (see `.env.example` for the full list)
4. Deploy

### Step 5 — Update URLs After First Deploy

Once you have your Vercel URL, update it in **4 places**:
- Vercel env var `SHOPIFY_APP_URL` (then redeploy)
- `shopify.app.toml` → `application_url` and `redirect_urls`
- Partner Dashboard → App URL
- Partner Dashboard → Allowed redirection URL(s)

### Step 6 — Install on Your Store

Partner Dashboard → your app → **Test your app** → select store → **Install**

---

## Environment Variables

See `.env.example`. In Vercel, also set `CRON_SECRET` (any random string) to secure the `/api/cron` endpoint.

---

## How Sorting Works

**Normal mode (4-tier):**
1. Featured + in stock (your saved order)
2. Non-featured + in stock (inventory high → low)
3. Non-featured + out of stock
4. Featured + out of stock (demoted to the very bottom)

**OOS-only mode:**
- Only out-of-stock items move to the bottom
- All other items keep their current relative order (captured via a position snapshot)
- When an OOS item returns to stock, it's automatically restored to its original position on the next sort
- Use the **Refresh Snapshot** button after manually reordering products in Shopify admin to update the canonical order

**Location-based inventory (optional):**
- Configure in the **Settings** page
- If you select specific locations, in-stock/out-of-stock status is based only on inventory at those locations
- If no locations are selected, falls back to total inventory across all locations

---

## Daily Auto-Sort

Configured in the **Schedule** page. Runs once daily (Vercel Hobby plan limit) via `vercel.json`'s `crons` config, currently set to `0 5 * * *` (5 AM UTC = midnight Eastern, adjusting for DST).

---

## Local Development

```bash
cp .env.example .env
# fill in your values
npm install
shopify app dev
```

---

## Required Scopes

- `read_products`, `write_products` — products and collections
- `read_inventory` — inventory levels
- `read_locations` — for location-based inventory filtering

---

## Troubleshooting

**Blank screen / `{}` in Shopify admin:** Check that `unstable_newEmbeddedAuthStrategy: true` is set in `shopify.server.js` and that all 4 URL locations match exactly.

**Cron not running:** Visit `/api/cron` directly with the `Authorization: Bearer <CRON_SECRET>` header to test manually. Check Vercel function logs for `[CRON]` entries.

**Supabase WebSocket crash on Vercel:** Already fixed — `ws` package is installed and passed as the realtime transport in `db.server.js`.

**"Access denied" on collections query:** Scopes were changed after initial install — uninstall and reinstall the app to get a fresh token with current scopes.
