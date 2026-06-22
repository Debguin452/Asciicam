export const onRequestGet: PagesFunction = async ({ request, env, params }) => {
  const id = (params.id as string ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
  const watchHtml = await (env as any).ASSETS.fetch(new Request(new URL("/watch.html", request.url)));
  const html = await watchHtml.text();

  const metaInjected = html
    .replace('<meta property="og:title" content="ATV Video" />', `<meta property="og:title" content="ATV Video ${id}" />`)
    .replace('const id = location.pathname.split(\'/\').pop();', `const id = ${JSON.stringify(id)};`);

  return new Response(metaInjected, {
    headers: {
      "Content-Type": "text/html;charset=UTF-8",
      "Cache-Control": "public, max-age=60",
    }
  });
};
