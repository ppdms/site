import type { Photo } from "./types";
import { targetViewerSource } from "../viewer-sources";

const MAX_VIEWER_PREFETCHES = 2;

/**
 * Load a few screens of the sheet ahead and warm viewer-sized derivatives for
 * visible photos. The browser still chooses responsive sheet sources.
 */
export function prefetchGallery(
  container: HTMLElement,
  dialog: HTMLDialogElement,
  photos: readonly Photo[]
): void {
  if (dialog.open) {
    dialog.addEventListener("close", () => prefetchGallery(container, dialog, photos), { once: true });
    return;
  }
  const connection = (navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string };
  }).connection;
  if (connection?.saveData || connection?.effectiveType === "slow-2g" || connection?.effectiveType === "2g") return;

  const byId = new Map(photos.map((photo) => [photo.id, photo]));
  const stage = dialog.querySelector<HTMLElement>(".pv-stage")!;
  const visible = new Set<HTMLImageElement>();
  const active = new Map<HTMLImageElement, HTMLImageElement>();
  const attempted = new Set<string>();

  function viewerSource(photo: Photo): string | undefined {
    if (photo.sources.length === 0) return undefined;
    const aspect = photo.width / photo.height;
    const style = getComputedStyle(stage);
    const availableWidth = Math.max(1, window.innerWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
    const availableHeight = Math.max(1, window.innerHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom));
    const width = Math.min(availableWidth, availableHeight * aspect);
    const height = width / aspect;
    const scale = window.devicePixelRatio * (window.visualViewport?.scale ?? 1);
    return photo.sources[targetViewerSource(photo, photo.sources, width, height, scale)]?.src;
  }

  function cancel(image: HTMLImageElement): void {
    const request = active.get(image);
    if (!request) return;
    active.delete(image);
    request.onload = null;
    request.onerror = null;
    request.removeAttribute("src");
  }

  function pump(): void {
    if (dialog.open || document.hidden || active.size >= MAX_VIEWER_PREFETCHES) return;
    const candidates = [...visible].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    // Let every visible sheet image finish before speculative viewer requests.
    if (candidates.some((image) => !image.complete)) return;
    for (const image of candidates) {
      if (active.size >= MAX_VIEWER_PREFETCHES) break;
      const id = image.closest<HTMLElement>(".gallery-photo")?.dataset.id;
      const photo = id && byId.get(id);
      if (!photo || image.naturalWidth === 0 || active.has(image)) continue;
      const src = viewerSource(photo);
      if (!src || attempted.has(src)) continue;
      if (new URL(src, document.baseURI).href === image.currentSrc) {
        attempted.add(src);
        continue;
      }

      const request = new Image();
      request.fetchPriority = "low";
      request.decoding = "async";
      active.set(image, request);
      request.onload = request.onerror = () => {
        active.delete(image);
        attempted.add(src);
        pump();
      };
      request.src = src;
    }
  }

  const ahead = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const image = entry.target as HTMLImageElement;
      image.loading = "eager";
      ahead.unobserve(image);
    }
  }, { rootMargin: `${window.innerHeight}px 0px ${window.innerHeight * 3}px 0px` });

  const onScreen = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const image = entry.target as HTMLImageElement;
      if (entry.isIntersecting) {
        visible.add(image);
      } else {
        visible.delete(image);
        if (!dialog.open) cancel(image);
      }
    }
    pump();
  });

  for (const image of container.querySelectorAll<HTMLImageElement>(".gallery-photo-image")) {
    ahead.observe(image);
    onScreen.observe(image);
  }

  container.addEventListener("load", pump, true);
  container.addEventListener("error", pump, true);
  container.addEventListener("click", (event) => {
    const selected = event.target instanceof Element
      ? event.target.closest(".gallery-photo")?.querySelector("img.gallery-photo-image")
      : null;
    if (!selected) return;
    for (const image of active.keys()) {
      if (image !== selected) cancel(image);
    }
  }, true);
  dialog.addEventListener("close", pump);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && !dialog.open) {
      for (const image of active.keys()) cancel(image);
    } else {
      pump();
    }
  });
  window.addEventListener("resize", pump);
}
