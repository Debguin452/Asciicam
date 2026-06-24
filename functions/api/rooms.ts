interface Env { ROOMS_KV: KVNamespace; }

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function genCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  const arr = crypto.getRandomValues(new Uint8Array(6));
  for (const b of arr) code += chars[b % chars.length];
  return code;
}

export const onRequestOptions: PagesFunction = async () =>
  new Response(null, { headers: CORS });

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = await request.json().catch(() => null) as { peerId?: string } | null;
  const peerId = body?.peerId;
  if (!peerId || typeof peerId !== "string") return json({ error: "peerId required" }, 400);

  for (let i = 0; i < 5; i++) {
    const code = genCode();
    const existing = await env.ROOMS_KV.get(`room:${code}`);
    if (!existing) {
      await env.ROOMS_KV.put(`room:${code}`, JSON.stringify([peerId]), { expirationTtl: 3600 });
      return json({ code, peerId });
    }
  }
  return json({ error: "Could not generate unique room code, try again" }, 503);
};
