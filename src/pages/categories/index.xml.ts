import type { APIRoute } from "astro";
import { createPostsFeed } from "../../lib/rss";

export const GET: APIRoute = ({ site }) =>
  createPostsFeed(
    site,
    "Categories — Vassilis Papadimas",
    "Posts by category.",
    "/categories/index.xml"
  );
