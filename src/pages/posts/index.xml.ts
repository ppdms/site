import type { APIRoute } from "astro";
import { createPostsFeed } from "../../lib/rss";

export const GET: APIRoute = ({ site }) =>
  createPostsFeed(
    site,
    "Posts — Basil Papadimas",
    "Articles and travel photographs by Basil Papadimas.",
    "/posts/index.xml"
  );
