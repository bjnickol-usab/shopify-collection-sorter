export async function loader() {
  return new Response("OK - render pipeline is working", {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}
