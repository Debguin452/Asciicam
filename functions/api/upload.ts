interface Env {
  ATV_KV: KVNamespace;
  ATV_R2?: R2Bucket;
}

interface AtvMeta {
  id: string;
  name: string;
  size: number;
  uploadedAt: number;
  cols: number;
  rows: number;
  fps: number;
  frameCount: number;
  colorMode: boolean;
  durationMs: number;
}

function genId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(9)))
    .map(b => b.toString(36).padStart(2, "0")).join("").slice(0, 12);
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-ATV-Meta",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const metaHeader = request.headers.get("X-ATV-Meta");
    if (!metaHeader) {
      return new Response(JSON.stringify({ error: "Missing X-ATV-Meta header" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    let clientMeta: Partial<AtvMeta>;
    try { clientMeta = JSON.parse(atob(metaHeader)); }
    catch { return new Response(JSON.stringify({ error: "Invalid meta" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }

    const id = genId();
    const body = await request.arrayBuffer();

    if (body.byteLength > 50 * 1024 * 1024) {
      return new Response(JSON.stringify({ error: "File too large (max 50MB)" }), {
        status: 413, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const meta: AtvMeta = {
      id,
      name: (clientMeta.name ?? "video.atv").replace(/[^a-zA-Z0-9._-]/g, "_"),
      size: body.byteLength,
      uploadedAt: Date.now(),
      cols: clientMeta.cols ?? 0,
      rows: clientMeta.rows ?? 0,
      fps: clientMeta.fps ?? 15,
      frameCount: clientMeta.frameCount ?? 0,
      colorMode: clientMeta.colorMode ?? false,
      durationMs: clientMeta.durationMs ?? 0,
    };

    if (env.ATV_R2) {
      await env.ATV_R2.put(`atv/${id}.atv`, body, {
        httpMetadata: { contentType: "application/octet-stream" },
        customMetadata: { meta: JSON.stringify(meta) },
      });
    } else {
      const chunk = new Uint8Array(body);
      const b64 = btoa(String.fromCharCode(...chunk.slice(0, Math.min(chunk.length, 2 * 1024 * 1024))));
      await env.ATV_KV.put(`atv:data:${id}`, b64, { expirationTtl: 86400 * 30 });
    }

    await env.ATV_KV.put(`atv:meta:${id}`, JSON.stringify(meta), { expirationTtl: 86400 * 30 });

    const list = JSON.parse(await env.ATV_KV.get("atv:list") ?? "[]") as string[];
    list.unshift(id);
    if (list.length > 1000) list.splice(1000);
    await env.ATV_KV.put("atv:list", JSON.stringify(list));

    return new Response(JSON.stringify({ id, watchUrl: `/watch/${id}` }), {
      status: 201,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
};

export const onRequestOptions: PagesFunction<Env> = async () => {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-ATV-Meta",
    }
  });
};
                                                                  
