import { login } from "../shopify.server.js";

export const loader = async ({ request }) => {
  return login(request);
};
