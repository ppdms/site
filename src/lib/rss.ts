import rss from "@astrojs/rss";
import { getCollection } from "astro:content";
import type { CollectionEntry } from "astro:content";
import { renderMarkdownToHtml } from "./markdown";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export async function createPostsFeed(
  site: URL | undefined,
  title: string,
  description: string,
  feedPath: string
): Promise<Response> {
  const posts: CollectionEntry<"posts">[] = await getCollection("posts");
  const visiblePosts = posts.filter((post) => !post.data.draft);
  const siteUrl = new URL(site || "https://papadim.as");
  visiblePosts.sort((a, b) => {
    const dateDiff = b.data.date.getTime() - a.data.date.getTime();
    if (dateDiff !== 0) return dateDiff;
    return a.data.slug.localeCompare(b.data.slug);
  });

  const items = await Promise.all(
    visiblePosts.map(async (post) => ({
      title: post.data.title,
      description: post.data.description,
      link: new URL(`${post.data.slug}/`, siteUrl).toString(),
      pubDate: post.data.date,
      categories: [post.data.type, ...post.data.categories, ...post.data.tags],
      author: post.data.author,
      content: await renderMarkdownToHtml(post.body ?? ""),
    }))
  );

  const feedUrl = new URL(feedPath, siteUrl).toString();
  return rss({
    title,
    description,
    site: site || "https://papadim.as",
    xmlns: { atom: "http://www.w3.org/2005/Atom" },
    customData: `<link>${escapeXml(feedUrl)}</link><atom:link href="${escapeXml(
      feedUrl
    )}" rel="self" type="application/rss+xml" />`,
    items,
  });
}
