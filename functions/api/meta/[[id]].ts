interface Env {
  ATV_KV: KVNamespace;
}

function cors(h: Record<string, string> = {}): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json",
    ...h,
  };
}

export const onRequestGet: PagesFunction<Env> = async ({ params, env }) => {
  const id = (params.id as string ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!id) return new Response(JSON.stringify({ error: "Missing ID" }), { status: 400, headers: cors() });

  const raw = await env.ATV_KV.get(`atv:meta:${id}`);
  if (!raw) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: cors() });

  return new Response(raw, { headers: cors({ "Cache-Control": "public, max-age=300" }) });
};

export const onRequestOptions: PagesFunction<Env> = async () =>
  new Response(null, { headers: cors() });
