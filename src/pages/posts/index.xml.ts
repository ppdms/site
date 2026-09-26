import type { APIRoute } from "astro";
import { createPostsFeed } from "../../lib/rss";

export const GET: APIRoute = ({ site }) =>
  createPostsFeed(
    site,
    "Posts — Vassilis Papadimas",
    "Articles and travel photographs by Vassilis Papadimas.",
    "/posts/index.xml"
  );
