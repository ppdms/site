import { getCollection } from "astro:content";
import type { CollectionEntry } from "astro:content";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export async function GET(): Promise<Response> {
  const posts: CollectionEntry<"posts">[] = await getCollection("posts");
  const visiblePosts = posts.filter((post) => !post.data.draft);
  const urls = [
    "/",
    "/posts/",
    "/gallery/",
    "/backlinks/",
    "/categories/",
    "/tags/",
    "/404.html",
    ...visiblePosts.map((post) => `/${post.data.slug}/`),
  ];
  const body = urls
    .map((path) => `  <url><loc>${escapeXml(`https://papadim.as${path}`)}</loc></url>`)
    .join("\n");

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>`,
    { headers: { "content-type": "application/xml; charset=utf-8" } }
  );
}
