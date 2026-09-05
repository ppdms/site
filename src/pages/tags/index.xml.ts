import type { APIRoute } from "astro";
import { createPostsFeed } from "../../lib/rss";

export const GET: APIRoute = ({ site }) =>
  createPostsFeed(
    site,
    "Tags — Basil Papadimas",
    "Posts by tag.",
    "/tags/index.xml"
  );
