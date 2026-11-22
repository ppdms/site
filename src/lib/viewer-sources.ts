import type { ImageSource, Photo } from "./gallery/types";

const PREVIEW_LONG_EDGE = 640;

/** Sources in ascending resolution, starting with a useful preview. */
export function viewerSources(photo: Photo): ImageSource[] {
  const sources = photo.sources.filter(
    (source) => Math.max(source.width, source.height) >= PREVIEW_LONG_EDGE
  );
  if (sources.length === 0 && photo.sources.length > 0) {
    sources.push(photo.sources[photo.sources.length - 1]);
  }
  if (photo.original && !sources.some((source) => source.src === photo.original)) {
    sources.push({ src: photo.original, width: photo.width, height: photo.height });
  }
  return sources;
}

/** Smallest source that fills the fitted image at the current physical pixel density. */
export function targetViewerSource(
  photo: Photo,
  sources: readonly ImageSource[],
  width: number,
  height: number,
  pixelScale: number
): number {
  const targetWidth = Math.min(photo.width, Math.ceil(width * pixelScale));
  const targetHeight = Math.min(photo.height, Math.ceil(height * pixelScale));
  const index = sources.findIndex(
    (source) => source.width >= targetWidth && source.height >= targetHeight
  );
  return index < 0 ? sources.length - 1 : index;
}
