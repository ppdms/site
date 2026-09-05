import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const RESERVED_SLUGS = new Set([
  "",
  "posts",
  "gallery",
  "backlinks",
  "tags",
  "categories",
  "404",
  "cv",
  "CV_Basil_Papadimas.pdf",
]);

function parseUtcDate(value: string | Date): Date {
  if (value instanceof Date) return value;
  const str = value.trim();
  if (str.includes("T")) {
    return new Date(/[zZ]|[+-]\d{2}:\d{2}$/.test(str) ? str : `${str}Z`);
  }
  return new Date(`${str}T00:00:00Z`);
}

const posts = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/posts" }),
  schema: z
    .object({
      title: z.string(),
      slug: z.string().refine((s) => !RESERVED_SLUGS.has(s), {
        message: "Slug is reserved",
      }),
      description: z.string(),
      author: z.string(),
      date: z.union([z.string(), z.date()]).transform(parseUtcDate).refine((date) => Number.isFinite(date.getTime()), {
        message: "date must be a valid calendar date",
      }),
      lastmod: z
        .union([z.string(), z.date()])
        .optional()
        .transform((val) => (val ? parseUtcDate(val) : undefined))
        .refine((date) => date === undefined || Number.isFinite(date.getTime()), {
          message: "lastmod must be a valid calendar date",
        }),
      type: z.enum(["article", "travel"]).default("article"),
      photo_captions: z.boolean().default(false),
      captions: z.record(z.string(), z.string()).default({}),
      alts: z.record(z.string(), z.string()).default({}),
      categories: z.array(z.string()).default([]),
      tags: z.array(z.string()).default([]),
      draft: z.boolean().default(false),
    }),
});

const home = defineCollection({
  loader: glob({ pattern: "home.md", base: "./src/content" }),
  schema: z.object({
    title: z.string(),
  }),
});

export const collections = { posts, home };
