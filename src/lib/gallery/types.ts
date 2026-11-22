import { z } from "astro/zod";

const url = z.string().refine((value) => {
  if (value.startsWith("/") && !value.startsWith("//")) return true;
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}, "Expected an HTTP(S) or root-relative URL");

const dimension = z.number().int().positive();
const source = z.object({
  src: url.refine((value) => /\.webp$/i.test(value.split(/[?#]/, 1)[0]), "Expected a WebP derivative"),
  width: dimension,
  height: dimension,
});

const photo = z.object({
  id: z.string().refine((value) => value.trim().length > 0, "Expected a non-empty id"),
  width: dimension,
  height: dimension,
  alt: z.string(),
  caption: z.string().optional(),
  original: url,
  sources: z.array(source).min(1).superRefine((sources, context) => {
    for (let i = 1; i < sources.length; i++) {
      if (sources[i].width <= sources[i - 1].width) {
        context.addIssue({ code: "custom", message: "sources must be sorted by strictly increasing width" });
        break;
      }
    }
  }),
  exif: z.object({
    Date: z.string().optional(),
    Lat: z.number().optional(),
    Long: z.number().optional(),
    Tags: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  }).optional(),
});

const manifest = z.object({
  version: z.literal(1),
  images: z.array(photo).superRefine((images, context) => {
    const ids = new Set<string>();
    for (const image of images) {
      if (ids.has(image.id)) {
        context.addIssue({ code: "custom", message: `duplicate id ${JSON.stringify(image.id)}` });
      }
      ids.add(image.id);
    }
  }),
});

export type ImageSource = z.infer<typeof source>;
export type Photo = z.infer<typeof photo>;
export type GalleryManifest = z.infer<typeof manifest>;

export function parseManifest(value: unknown): GalleryManifest {
  return manifest.parse(value);
}
