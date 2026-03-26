import { createRequestHandler } from "@vercel/remix";
import { addDocumentResponseHeaders } from "./shopify.server.js";

export default createRequestHandler({
  // @ts-ignore
  build: () => import("virtual:remix/server-build"),
  getLoadContext(req, res) {
    return {};
  },
});
