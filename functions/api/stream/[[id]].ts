interface Env {
  ATV_KV: KVNamespace;
  ATV_R2?: R2Bucket;
}

function cors(h: Record<string, string> = {}): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    ...h,
  };
}

export const onRequestGet: PagesFunction<Env> = async ({ params, env }) => {
  const id = (params.id as string ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!id) {
    return new Response(JSON.stringify({ error: "Missing ID" }), {
      status: 400, headers: cors({ "Content-Type": "application/json" })
    });
  }

  try {
    if (env.ATV_R2) {
      const obj = await env.ATV_R2.get(`atv/${id}.atv`);
      if (!obj) {
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404, headers: cors({ "Content-Type": "application/json" })
        });
      }
      return new Response(obj.body, {
        headers: cors({
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${id}.atv"`,
          "Cache-Control": "public, max-age=86400",
          "Content-Length": String(obj.size),
        })
      });
    }

    const b64 = await env.ATV_KV.get(`atv:data:${id}`);
    if (!b64) {
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404, headers: cors({ "Content-Type": "application/json" })
      });
    }

    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    return new Response(bytes, {
      headers: cors({
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${id}.atv"`,
        "Cache-Control": "public, max-age=86400",
        "Content-Length": String(bytes.length),
      })
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: cors({ "Content-Type": "application/json" })
    });
  }
};

export const onRequestOptions: PagesFunction<Env> = async () =>
  new Response(null, { headers: cors() });
