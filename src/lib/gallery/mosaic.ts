import type { Photo } from "./types";

export const MOSAIC_COLUMNS = 12;
export const MOSAIC_ROWS = 8;

/** Evenly sample the gallery in manifest order for the homepage card. */
export function mosaicSources(photos: readonly Pick<Photo, "sources" | "original">[]): string[] {
  const count = Math.min(MOSAIC_COLUMNS * MOSAIC_ROWS, photos.length);
  return Array.from({ length: count }, (_, i) => {
    const photo = photos[Math.floor(i * photos.length / count)];
    return photo.sources[0]?.src ?? photo.original;
  });
}
