export const GET = () =>
  new Response(
    "User-agent: *\nAllow: /\n\nSitemap: https://papadim.as/sitemap.xml\n",
    { headers: { "content-type": "text/plain; charset=utf-8" } }
  );
