interface Env { ROOMS_KV: KVNamespace; }

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function getCode(params: Params): string {
  const raw = Array.isArray(params.code) ? params.code[0] : params.code ?? "";
  return raw.toUpperCase();
}

async function getRoomPeers(kv: KVNamespace, code: string): Promise<string[]> {
  const raw = await kv.get(`room:${code}`);
  if (!raw) return [];
  try { return JSON.parse(raw) as string[]; } catch { return []; }
}

async function setRoomPeers(kv: KVNamespace, code: string, peers: string[]): Promise<void> {
  await kv.put(`room:${code}`, JSON.stringify(peers), { expirationTtl: 3600 });
}

export const onRequestOptions: PagesFunction = async () =>
  new Response(null, { headers: CORS });

export const onRequestGet: PagesFunction<Env> = async ({ params, env }) => {
  const code = getCode(params);
  if (!code) return json({ error: "code required" }, 400);
  const peers = await getRoomPeers(env.ROOMS_KV, code);
  return json({ code, peers });
};

export const onRequestPut: PagesFunction<Env> = async ({ request, params, env }) => {
  const code = getCode(params);
  const body = await request.json().catch(() => null) as { peerId?: string } | null;
  const peerId = body?.peerId;
  if (!code || !peerId) return json({ error: "code and peerId required" }, 400);
  const peers = await getRoomPeers(env.ROOMS_KV, code);
  if (peers.length === 0) return json({ error: "Room not found" }, 404);
  if (!peers.includes(peerId)) {
    peers.push(peerId);
    await setRoomPeers(env.ROOMS_KV, code, peers);
  }
  return json({ code, peers });
};

export const onRequestDelete: PagesFunction<Env> = async ({ request, params, env }) => {
  const code = getCode(params);
  const body = await request.json().catch(() => null) as { peerId?: string } | null;
  const peerId = body?.peerId;
  if (!code) return json({ error: "code required" }, 400);
  const peers = await getRoomPeers(env.ROOMS_KV, code);
  const filtered = peerId ? peers.filter(p => p !== peerId) : [];
  if (filtered.length === 0) await env.ROOMS_KV.delete(`room:${code}`);
  else await setRoomPeers(env.ROOMS_KV, code, filtered);
  return json({ ok: true });
};
