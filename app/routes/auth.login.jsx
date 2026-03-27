import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { login } from "../shopify.server.js";

export async function loader({ request }) {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");

  if (shop) {
    // Shop param present — hand off to Shopify OAuth
    return await login(request);
  }

  // No shop param — show a form so user can enter their store
  return json({ showForm: true });
}

export async function action({ request }) {
  return await login(request);
}

export default function AuthLogin() {
  const { showForm } = useLoaderData();

  if (!showForm) return null;

  return (
    <html>
      <head>
        <meta charSet="utf-8" />
        <title>Collection Sorter — Install</title>
        <style>{`
          body { font-family: sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f6f6f7; }
          .card { background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); width: 100%; max-width: 400px; }
          h1 { font-size: 20px; margin-bottom: 8px; }
          p { color: #666; margin-bottom: 24px; font-size: 14px; }
          input { width: 100%; padding: 10px 12px; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; box-sizing: border-box; margin-bottom: 12px; }
          button { width: 100%; padding: 10px; background: #008060; color: white; border: none; border-radius: 6px; font-size: 14px; cursor: pointer; }
          button:hover { background: #006e52; }
        `}</style>
      </head>
      <body>
        <div className="card">
          <h1>Collection Sorter</h1>
          <p>Enter your Shopify store domain to install the app.</p>
          <form method="post" action="/auth/login">
            <input
              type="text"
              name="shop"
              placeholder="your-store.myshopify.com"
              autoFocus
            />
            <button type="submit">Install App</button>
          </form>
        </div>
      </body>
    </html>
  );
}
