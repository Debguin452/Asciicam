// Cloudflare Pages Function — Room signaling (free KV tier)
// POST /api/rooms          → create room, return { code, peerId }
// GET  /api/rooms/:code    → get peer IDs in room
// PUT  /api/rooms/:code    → join room with peerId in body
// DELETE /api/rooms/:code  → leave room

interface Env { ROOMS_KV: KVNamespace; }

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function genCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I confusion
  let code = "";
  const arr = crypto.getRandomValues(new Uint8Array(6));
  for (const b of arr) code += chars[b % chars.length];
  return code;
}

async function getRoomPeers(kv: KVNamespace, code: string): Promise<string[]> {
  const raw = await kv.get(`room:${code}`);
  if (!raw) return [];
  try { return JSON.parse(raw) as string[]; } catch { return []; }
}

async function setRoomPeers(kv: KVNamespace, code: string, peers: string[]): Promise<void> {
  // TTL 3600s — rooms expire after 1 hour automatically
  await kv.put(`room:${code}`, JSON.stringify(peers), { expirationTtl: 3600 });
}

export const onRequestOptions: PagesFunction = async () =>
  new Response(null, { headers: CORS });

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = await request.json().catch(() => null) as { peerId?: string } | null;
  const peerId = body?.peerId;
  if (!peerId || typeof peerId !== "string") return json({ error: "peerId required" }, 400);

  // Try up to 5 codes to avoid collision
  for (let i = 0; i < 5; i++) {
    const code = genCode();
    const existing = await getRoomPeers(env.ROOMS_KV, code);
    if (existing.length === 0) {
      await setRoomPeers(env.ROOMS_KV, code, [peerId]);
      return json({ code, peerId });
    }
  }
  return json({ error: "Could not generate unique room code, try again" }, 503);
};

export const onRequestGet: PagesFunction<Env> = async ({ params, env }) => {
  const code = (Array.isArray(params.code) ? params.code[0] : params.code ?? "").toUpperCase();
  if (!code) return json({ error: "code required" }, 400);
  const peers = await getRoomPeers(env.ROOMS_KV, code);
  return json({ code, peers });
};

export const onRequestPut: PagesFunction<Env> = async ({ request, params, env }) => {
  const code = (Array.isArray(params.code) ? params.code[0] : params.code ?? "").toUpperCase();
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
  const code = (Array.isArray(params.code) ? params.code[0] : params.code ?? "").toUpperCase();
  const body = await request.json().catch(() => null) as { peerId?: string } | null;
  const peerId = body?.peerId;
  if (!code) return json({ error: "code required" }, 400);
  const peers = await getRoomPeers(env.ROOMS_KV, code);
  const filtered = peers.filter(p => p !== peerId);
  if (filtered.length === 0) await env.ROOMS_KV.delete(`room:${code}`);
  else await setRoomPeers(env.ROOMS_KV, code, filtered);
  return json({ ok: true });
};
