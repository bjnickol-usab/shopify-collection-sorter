export async function loader() {
  return new Response("route loader works", {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

export default function Debug2() {
  return (
    <div>
      <h1>Hello from Debug2</h1>
      <p>If you can see this, basic component rendering works.</p>
    </div>
  );
}
