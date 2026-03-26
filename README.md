# Shopify Collection Sorter

Sort products in any Shopify collection by inventory level (highest → lowest), with the ability to pin "featured" products at the top.

## What It Does

- Lists all collections in your Shopify store
- For each collection, shows all products with their current inventory
- Lets you **star/feature** specific products → they are pinned to the top in a defined order
- All remaining products are sorted **highest inventory → lowest** below the featured items
- Pushes the sort order directly to Shopify with one click

---

## Tech Stack

- **Remix** (Shopify App Remix framework)
- **Supabase** (session storage + featured product configuration)
- **Vercel** (hosting)
- **GitHub** (source control)

---

## Setup Guide

### Step 1 — Create a Shopify Partner App

1. Go to [partners.shopify.com](https://partners.shopify.com) → **Apps → Create app**
2. Choose **Create app manually**
3. Name it `Collection Sorter`
4. Note your **Client ID** and **Client Secret**

### Step 2 — Create a Supabase Project

1. Go to [supabase.com](https://supabase.com) → **New Project**
2. Once created, go to **Settings → API**
3. Note your **Project URL** and **service_role** key (under "Project API keys")
4. Go to **SQL Editor** → run the entire contents of `supabase/schema.sql`

### Step 3 — Create a GitHub Repository

```bash
git init
git add .
git commit -m "Initial commit"
gh repo create shopify-collection-sorter --private --push --source=.
# Or manually create on github.com and push
```

### Step 4 — Deploy to Vercel

1. Go to [vercel.com](https://vercel.com) → **New Project** → Import your GitHub repo
2. Under **Environment Variables**, add:

| Variable | Value |
|---|---|
| `SHOPIFY_API_KEY` | Your Shopify Client ID |
| `SHOPIFY_API_SECRET` | Your Shopify Client Secret |
| `SHOPIFY_APP_URL` | Leave blank for now — add after first deploy |
| `SUPABASE_URL` | Your Supabase Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Your Supabase service_role key |
| `SESSION_SECRET` | Any random 32+ character string |

3. Click **Deploy**

### Step 5 — Update URLs After First Deploy

After Vercel finishes, you'll have a URL like `https://shopify-collection-sorter-xyz.vercel.app`

Update it in **4 places**:

**A) Vercel Environment Variables:**
- Set `SHOPIFY_APP_URL` to your Vercel URL
- Trigger a redeploy: Settings → Deployments → Redeploy

**B) shopify.app.toml (local file):**
```toml
application_url = "https://your-app.vercel.app"

[auth]
redirect_urls = [
  "https://your-app.vercel.app/auth/callback",
  "https://your-app.vercel.app/auth/shopify/callback",
  ...
]
```
Then: `git add shopify.app.toml && git commit -m "update app url" && git push`

**C) shopify.app.toml → `client_id`:**
Replace `YOUR_SHOPIFY_CLIENT_ID` with your actual Client ID.

**D) Shopify Partner Dashboard:**
- App → App setup → **App URL** → your Vercel URL
- **Allowed redirection URL(s)** → add both `/auth/callback` and `/auth/shopify/callback`

### Step 6 — Install on Your Store

1. In the Shopify Partner Dashboard, go to your app
2. Click **Select store** → choose your development or production store
3. Click **Install app**

---

## How the Sort Works

When you click **Apply Sort to Shopify**:

1. All featured products (in the order you've arranged them) go to positions 1, 2, 3…
2. All remaining products are sorted by `totalInventory` descending (highest stock first)
3. The collection's sort order is set to `MANUAL` if it isn't already
4. Shopify's `collectionReorderProducts` mutation applies the new positions

> **Note:** Shopify processes the reorder asynchronously. It may take a few seconds to reflect in your storefront.

---

## Required Scopes

- `read_products` — to fetch products and their inventory
- `write_products` — to update collection sort order and product positions
- `read_inventory` — for inventory data
- `read_locations` — for multi-location inventory context

---

## Local Development

```bash
cp .env.example .env
# Fill in your .env values

npm install
shopify app dev
```

This will open a tunnel and install the app on your development store automatically.

---

## Troubleshooting

**"refused to connect" in Shopify admin:**
The app URL in the Partner Dashboard doesn't match your Vercel URL. Double-check all 4 places listed in Step 5.

**Sort not applying:**
Make sure the collection is set to `MANUAL` sort in Shopify — the app does this automatically, but if there's an error, check the toast message.

**Products showing 0 inventory:**
`totalInventory` is the sum across all locations and variants. If a product has inventory tracked at specific locations but not aggregated, this may show as 0. Check Shopify admin to confirm.

**Vercel build failing:**
Check that all environment variables are set. The app will throw on startup if `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` are missing.
