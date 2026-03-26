import { json } from "@remix-run/node";
import { Outlet } from "@remix-run/react";
import { authenticate } from "../shopify.server.js";

export async function loader({ request }) {
  await authenticate.admin(request);
  return json({});
}

export default function App() {
  return <Outlet />;
}
