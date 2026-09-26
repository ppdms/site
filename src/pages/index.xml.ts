import type { APIRoute } from "astro";
import { createPostsFeed } from "../lib/rss";

export const GET: APIRoute = ({ site }) =>
  createPostsFeed(
    site,
    "Vassilis Papadimas",
    "Articles and travel photographs by Vassilis Papadimas.",
    "/index.xml"
  );
