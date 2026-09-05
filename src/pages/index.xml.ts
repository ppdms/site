import type { APIRoute } from "astro";
import { createPostsFeed } from "../lib/rss";

export const GET: APIRoute = ({ site }) =>
  createPostsFeed(
    site,
    "Basil Papadimas",
    "Articles and travel photographs by Basil Papadimas.",
    "/index.xml"
  );
