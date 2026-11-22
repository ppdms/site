import type { Map as MapLibreMap } from "maplibre-gl";
import type { ImageSource, Photo } from "./gallery/types";
import { targetViewerSource, viewerSources } from "./viewer-sources";
import { startImageLoad } from "./viewer-image";
import infoSvg from "@phosphor-icons/core/assets/bold/info-bold.svg?raw";
import downloadSvg from "@phosphor-icons/core/assets/bold/download-simple-bold.svg?raw";
import closeSvg from "@phosphor-icons/core/assets/bold/x-bold.svg?raw";
import chevronLeftSvg from "@phosphor-icons/core/assets/bold/caret-left-bold.svg?raw";
import chevronRightSvg from "@phosphor-icons/core/assets/bold/caret-right-bold.svg?raw";

function icon(raw: string): string {
  return raw.replace(/<!--[\s\S]*?-->\s*/g, "").replace("<svg", '<svg aria-hidden="true"');
}

export interface ViewerController {
  open(id: string, opener?: HTMLElement): void;
  close(): void;
  destroy(): void;
}

export interface ViewerOptions {
  syncImageQuery: boolean;
  enableExif: boolean;
  downloadLabel?: "Download original" | "Download original image" | "Open full size";
}

interface PhotoLocation {
  lat: number;
  lng: number;
}

interface SpecRow {
  label: string;
  value: string;
  dateTime?: string;
  href?: string;
}

interface PhotoSlot {
  index: number;
  photo: Photo;
  rungs: ImageSource[];
  displayedRung: number;
  displayedImg: HTMLImageElement | null;
  cancelInFlight: (() => void) | null;
  cancelPreview: (() => void) | null;
  previewFailed: boolean;
  upgradeToken: number;
  allFailed: boolean;
  error: HTMLElement | null;
}

/** Keep one low-priority preview either side of the current photograph. */
const NEIGHBOURS = 1;
const DRAG_SLOP = 10;
const SWIPE_THRESHOLD = 48;

function mod(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function circularDistance(a: number, b: number, length: number): number {
  const diff = Math.abs(a - b);
  return Math.min(diff, length - diff);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function readAperture(value: string | number): string {
  if (typeof value === "number") return String(value);
  const [numerator, denominator] = value.split("/").map(Number);
  if (value.includes("/") && denominator && !Number.isNaN(numerator)) {
    return (numerator / denominator).toFixed(1).replace(/\.0$/, "");
  }
  return value;
}

function readOptics(lensModel: string): { camera?: string; lens: string } {
  const phone = /^(.+?) (?:back|front) .*?camera ([\d.]+)mm f\/([\d.]+)$/i.exec(lensModel);
  if (phone) return { camera: phone[1], lens: `${phone[2]}\u00a0mm · ƒ/${phone[3]}` };
  return {
    lens: lensModel
      .replace(/(\d)-(\d)/g, "$1–$2")
      .replace(/(\d)\s*mm\b/g, "$1\u00a0mm")
      .replace(/\bF(?=\d)/g, "ƒ/"),
  };
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function readLocation(photo: Photo): PhotoLocation | null {
  const lat = photo.exif?.Lat;
  const lng = photo.exif?.Long;
  if (lat === undefined || lng === undefined) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

function formatDegrees(value: number, positive: string, negative: string): string {
  const total = Math.round(Math.abs(value) * 3600);
  const degrees = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${degrees}°${pad(minutes)}′${pad(seconds)}″\u00a0${value >= 0 ? positive : negative}`;
}

function formatCoordinates({ lat, lng }: PhotoLocation): string {
  return `${formatDegrees(lat, "N", "S")}  ${formatDegrees(lng, "E", "W")}`;
}

function mapsUrl({ lat, lng }: PhotoLocation): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lat},${lng}`)}`;
}

function buildSpecs(photo: Photo, enableExif: boolean): {
  specs: SpecRow[];
  location: PhotoLocation | null;
} {
  if (!enableExif || !photo.exif) {
    return { specs: [], location: null };
  }

  const specs: SpecRow[] = [];
  const exif = photo.exif;
  const tags = exif.Tags;

  if (exif.Date) {
    specs.push({ label: "Date", value: formatDate(exif.Date), dateTime: exif.Date });
  }
  if (tags?.ExposureTime) {
    const raw = String(tags.ExposureTime);
    specs.push({ label: "Shutter", value: `${raw}\u00a0s` });
  }
  if (tags?.FNumber !== undefined) {
    specs.push({ label: "Aperture", value: `ƒ/${readAperture(tags.FNumber)}` });
  }
  if (tags?.ISO) {
    specs.push({ label: "ISO", value: String(tags.ISO) });
  }
  if (tags?.FocalLengthIn35mmFormat) {
    specs.push({ label: "Focal length", value: `${tags.FocalLengthIn35mmFormat}\u00a0mm` });
  }
  if (tags?.LensModel) {
    const optics = readOptics(String(tags.LensModel));
    if (optics.camera) specs.push({ label: "Camera", value: optics.camera });
    specs.push({ label: "Lens", value: optics.lens });
  }

  const location = readLocation(photo);
  if (location) {
    specs.push({
      label: "Location",
      value: formatCoordinates(location),
      href: mapsUrl(location),
    });
  }

  return { specs, location };
}

/**
 * Full-viewport modal photo viewer aligned with the site's grid, typography,
 * and light/dark themes. Shows a preview, then loads the smallest derivative
 * that fits the display, decoding it before replacing the displayed image.
 */
export function createViewer(
  dialog: HTMLDialogElement,
  photos: readonly Photo[],
  options: ViewerOptions
): ViewerController {
  const downloadLabel = options.downloadLabel ?? "Download original image";
  const detailsId = `${dialog.id || "pv"}-details`;

  let openerElement: HTMLElement | null = null;
  let openedViaPush = false;
  let savedScrollY = 0;
  let currentIndex = 0;
  let detailsOpen = false;
  let activeOriginalUrl = "";

  let map: MapLibreMap | null = null;
  let mapHost: HTMLElement | null = null;
  let mapGeneration = 0;

  const slots = new Map<number, PhotoSlot>();

  const photoIndexMap = new Map<string, number>();
  for (let i = 0; i < photos.length; i++) {
    photoIndexMap.set(photos[i].id, i);
  }

  // Hoist the dialog out of main#content so article link/figure styles do not leak in.
  if (dialog.parentElement !== document.body) {
    document.body.append(dialog);
  }

  dialog.innerHTML = `
    <div class="pv-shell" role="document">
      <header class="pv-header">
        <p class="pv-status" aria-live="polite"></p>
        <div class="pv-actions">
          <button type="button" class="pv-btn pv-details-toggle" aria-label="Show details" title="Details (I)" aria-expanded="false" aria-controls="${detailsId}" hidden>
            ${icon(infoSvg)}
          </button>
          <a class="pv-btn pv-download" target="_blank" rel="noopener noreferrer" aria-label="${downloadLabel}" title="${downloadLabel}">
            ${icon(downloadSvg)}
          </a>
          <button type="button" class="pv-btn pv-close" aria-label="Close photo viewer" title="Close (Esc)">
            ${icon(closeSvg)}
          </button>
        </div>
      </header>
      <div class="pv-body">
        <div class="pv-stage">
          <button type="button" class="pv-nav pv-prev" aria-label="Previous photo" title="Previous (←)">
            ${icon(chevronLeftSvg)}
          </button>
          <figure class="pv-figure">
            <div class="pv-frame"></div>
            <figcaption class="pv-caption" hidden></figcaption>
          </figure>
          <button type="button" class="pv-nav pv-next" aria-label="Next photo" title="Next (→)">
            ${icon(chevronRightSvg)}
          </button>
          <div class="pv-preload" aria-hidden="true"></div>
        </div>
        <aside id="${detailsId}" class="pv-details" aria-label="Photograph details" hidden></aside>
      </div>
    </div>
  `;

  const shell = dialog.querySelector<HTMLElement>(".pv-shell")!;
  const statusEl = dialog.querySelector<HTMLElement>(".pv-status")!;
  const detailsBtn = dialog.querySelector<HTMLButtonElement>(".pv-details-toggle")!;
  const downloadLink = dialog.querySelector<HTMLAnchorElement>(".pv-download")!;
  const closeBtn = dialog.querySelector<HTMLButtonElement>(".pv-close")!;
  const bodyEl = dialog.querySelector<HTMLElement>(".pv-body")!;
  const stageEl = dialog.querySelector<HTMLElement>(".pv-stage")!;
  const figureEl = dialog.querySelector<HTMLElement>(".pv-figure")!;
  const frameEl = dialog.querySelector<HTMLElement>(".pv-frame")!;
  const captionEl = dialog.querySelector<HTMLElement>(".pv-caption")!;
  const prevBtn = dialog.querySelector<HTMLButtonElement>(".pv-prev")!;
  const nextBtn = dialog.querySelector<HTMLButtonElement>(".pv-next")!;
  const preloadEl = dialog.querySelector<HTMLElement>(".pv-preload")!;
  const detailsEl = dialog.querySelector<HTMLElement>(".pv-details")!;

  if (photos.length < 2) {
    prevBtn.hidden = true;
    nextBtn.hidden = true;
  }

  function photoAlt(slot: PhotoSlot): string {
    const caption = slot.photo.caption?.trim() || "";
    return slot.photo.alt || caption || `Photograph ${slot.index + 1} of ${photos.length}`;
  }

  function unmountMap(): void {
    mapGeneration++;
    map?.remove();
    map = null;
    if (mapHost) {
      mapHost.replaceChildren();
      mapHost.className = "pv-map";
    }
    mapHost = null;
  }

  function mountMap(): void {
    const container = detailsEl.querySelector<HTMLElement>(".pv-map");
    if (!container) return;
    if (container === mapHost) {
      map?.resize();
      return;
    }
    unmountMap();
    mapHost = container;
    const token = mapGeneration;
    const lat = Number(container.dataset.lat);
    const lng = Number(container.dataset.lng);

    void (async () => {
      try {
        const { mountLocationMap } = await import("./location-map.js");
        if (token !== mapGeneration) return;
        container.classList.remove("pv-map-failed");
        container.textContent = "";
        map = mountLocationMap(container, [lng, lat], mapsUrl({ lat, lng }));
      } catch {
        if (token !== mapGeneration) return;
        container.classList.add("pv-map-failed");
        container.textContent = "Map could not be loaded.";
      }
    })();
  }

  function computeFittedSize(photo: Photo): { width: number; height: number } {
    const style = getComputedStyle(stageEl);
    const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const captionHeight = captionEl.hidden ? 0 : captionEl.offsetHeight + 12;
    const availW = Math.max(1, stageEl.clientWidth - padX);
    const availH = Math.max(1, stageEl.clientHeight - padY - captionHeight);
    const aspect = photo.width / photo.height || 1;

    let w = availW;
    let h = w / aspect;
    if (h > availH) {
      h = availH;
      w = h * aspect;
    }
    return {
      width: Math.max(1, Math.round(w)),
      height: Math.max(1, Math.round(h)),
    };
  }

  function sizeFrame(): void {
    const slot = slots.get(currentIndex);
    if (!slot) return;
    const { width, height } = computeFittedSize(slot.photo);
    frameEl.style.width = `${width}px`;
    frameEl.style.height = `${height}px`;
  }

  function clearError(slot: PhotoSlot): void {
    slot.error?.remove();
    slot.error = null;
  }

  function stopInFlight(slot: PhotoSlot): void {
    slot.upgradeToken++;
    slot.cancelInFlight?.();
    slot.cancelInFlight = null;
  }

  function stopPreview(slot: PhotoSlot): void {
    const cancel = slot.cancelPreview;
    slot.cancelPreview = null;
    cancel?.();
  }

  function showError(slot: PhotoSlot): void {
    if (slot.index !== currentIndex || slot.error) return;
    const error = el("div", "pv-error");
    error.append(el("p", "", "Photograph could not be loaded."));
    const retry = el("button", "pv-retry", "Retry");
    retry.type = "button";
    retry.addEventListener("click", () => {
      clearError(slot);
      stopInFlight(slot);
      stopPreview(slot);
      slot.allFailed = false;
      slot.previewFailed = false;
      slot.displayedRung = -1;
      slot.displayedImg?.remove();
      slot.displayedImg = null;
      warmPreview(slot);
      void runLadder(slot);
    });
    error.append(retry);
    frameEl.append(error);
    slot.error = error;
  }

  function swapDisplayed(slot: PhotoSlot, nextImg: HTMLImageElement, rungIndex: number): void {
    const prevImg = slot.displayedImg;
    const isCurrent = slot.index === currentIndex;
    const hadImage = prevImg !== null;

    nextImg.classList.add("pv-img-loaded");
    if (hadImage) {
      nextImg.classList.add("pv-img-instant");
    }

    if (isCurrent) {
      nextImg.alt = photoAlt(slot);
      nextImg.removeAttribute("aria-hidden");
      frameEl.append(nextImg);
      if (prevImg) {
        // Keep the previous bitmap visible until the replacement has fully faded in.
        if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
          requestAnimationFrame(() => requestAnimationFrame(() => prevImg.remove()));
        } else {
          const fade = nextImg.animate(
            [{ opacity: 0 }, { opacity: 1 }],
            { duration: 160, easing: "ease-out" }
          );
          void fade.finished.then(() => prevImg.remove(), () => prevImg.remove());
        }
      }
    } else {
      nextImg.alt = "";
      nextImg.setAttribute("aria-hidden", "true");
      preloadEl.append(nextImg);
      prevImg?.remove();
    }

    slot.displayedImg = nextImg;
    slot.displayedRung = rungIndex;
  }

  async function runLadder(slot: PhotoSlot): Promise<void> {
    if (slot.rungs.length === 0 || slot.cancelInFlight) return;

    const token = ++slot.upgradeToken;
    slot.allFailed = false;

    for (let i = Math.max(1, slot.displayedRung + 1); i < slot.rungs.length; i++) {
      if (token !== slot.upgradeToken || slot.index !== currentIndex) return;
      const { width, height } = computeFittedSize(slot.photo);
      const pixelScale = window.devicePixelRatio * (window.visualViewport?.scale ?? 1);
      const target = targetViewerSource(slot.photo, slot.rungs, width, height, pixelScale);
      if (slot.displayedRung >= target || (target === 0 && !slot.previewFailed)) return;
      i = Math.max(i, target);
      const src = slot.rungs[i].src;
      const task = startImageLoad(src, slot.photo, "high", preloadEl);
      slot.cancelInFlight = task.cancel;
      try {
        const img = await task.promise;
        if (slot.cancelInFlight === task.cancel) slot.cancelInFlight = null;
        if (token !== slot.upgradeToken || slot.index !== currentIndex) {
          img.remove();
          return;
        }
        clearError(slot);
        swapDisplayed(slot, img, i);
        stopPreview(slot);
      } catch {
        if (slot.cancelInFlight === task.cancel) slot.cancelInFlight = null;
        if (token !== slot.upgradeToken || slot.index !== currentIndex) return;
        // Try larger derivatives and the original if the preferred source fails.
      }
    }

    if (token !== slot.upgradeToken || slot.index !== currentIndex) return;
    if (slot.displayedImg === null) {
      slot.allFailed = true;
      if (!slot.cancelPreview) showError(slot);
    }
  }

  function resizePhoto(): void {
    if (!dialog.open) return;
    sizeFrame();
    const slot = slots.get(currentIndex);
    if (slot && !slot.cancelInFlight) void runLadder(slot);
  }

  function warmPreview(slot: PhotoSlot): void {
    if (slot.displayedRung >= 0 || slot.rungs.length === 0 || slot.cancelPreview || slot.previewFailed) return;
    const task = startImageLoad(
      slot.rungs[0].src,
      slot.photo,
      slot.index === currentIndex ? "high" : "low",
      preloadEl
    );
    slot.cancelPreview = task.cancel;
    void task.promise.then(
      (img) => {
        if (slot.cancelPreview !== task.cancel) {
          img.remove();
          return;
        }
        slot.cancelPreview = null;
        if (slot.displayedRung >= 0) {
          img.remove();
          return;
        }
        slot.allFailed = false;
        clearError(slot);
        swapDisplayed(slot, img, 0);
      },
      () => {
        if (slot.cancelPreview !== task.cancel) return;
        slot.cancelPreview = null;
        slot.previewFailed = true;
        if (slot.index === currentIndex) {
          if (slot.allFailed && !slot.displayedImg) showError(slot);
          else void runLadder(slot);
        }
      }
    );
  }

  function ensureSlot(index: number): PhotoSlot {
    let slot = slots.get(index);
    if (!slot) {
      slot = {
        index,
        photo: photos[index],
        rungs: viewerSources(photos[index]),
        displayedRung: -1,
        displayedImg: null,
        cancelInFlight: null,
        cancelPreview: null,
        previewFailed: false,
        upgradeToken: 0,
        allFailed: false,
        error: null,
      };
      slots.set(index, slot);
    }
    return slot;
  }

  function removeSlot(slot: PhotoSlot): void {
    stopInFlight(slot);
    stopPreview(slot);
    clearError(slot);
    slot.displayedImg?.remove();
    slot.displayedImg = null;
    slots.delete(slot.index);
  }

  function refreshWindow(): void {
    const reach = photos.length < 2 ? 0 : NEIGHBOURS;

    for (const slot of [...slots.values()]) {
      const dist = circularDistance(slot.index, currentIndex, photos.length);
      if (dist > reach) {
        removeSlot(slot);
        continue;
      }
      if (slot.index !== currentIndex) {
        stopInFlight(slot);
        clearError(slot);
        if (slot.displayedImg) {
          slot.displayedImg.alt = "";
          slot.displayedImg.setAttribute("aria-hidden", "true");
          if (slot.displayedImg.parentElement !== preloadEl) {
            preloadEl.append(slot.displayedImg);
          }
        }
      }
    }

    ensureSlot(currentIndex);
    for (let d = 1; d <= reach; d++) {
      ensureSlot(mod(currentIndex + d, photos.length));
      ensureSlot(mod(currentIndex - d, photos.length));
    }
  }

  function attachSlotToFrame(slot: PhotoSlot): void {
    frameEl.replaceChildren();
    if (slot.displayedImg) {
      slot.displayedImg.alt = photoAlt(slot);
      slot.displayedImg.removeAttribute("aria-hidden");
      slot.displayedImg.classList.add("pv-img-loaded", "pv-img-instant");
      frameEl.append(slot.displayedImg);
    }
    if (slot.allFailed) {
      showError(slot);
    }
  }

  function clearSlots(): void {
    for (const slot of [...slots.values()]) removeSlot(slot);
    frameEl.replaceChildren();
    preloadEl.replaceChildren();
  }

  function renderDetails(photo: Photo): boolean {
    detailsEl.replaceChildren();
    unmountMap();

    const { specs, location } = buildSpecs(photo, options.enableExif);
    const caption = photo.caption?.trim();
    const hasContent = specs.length > 0 || (options.enableExif && Boolean(caption));
    if (!hasContent) return false;

    const header = el("div", "pv-details-header");
    header.append(el("h2", "pv-details-title", "Details"));
    detailsEl.append(header);

    if (caption) {
      detailsEl.append(el("p", "pv-details-caption", caption));
    }

    if (specs.length > 0) {
      const list = el("dl", "pv-meta-list");
      for (const spec of specs) {
        const row = el("div", "pv-meta-row");
        row.append(el("dt", "pv-meta-label", spec.label));
        const dd = el("dd", "pv-meta-value");
        if (spec.dateTime) {
          const time = el("time", "", spec.value);
          time.dateTime = spec.dateTime;
          dd.append(time);
        } else if (spec.href) {
          const link = el("a", "pv-meta-link", spec.value);
          link.href = spec.href;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.title = "Open in Google Maps";
          dd.append(link);
        } else {
          dd.textContent = spec.value;
        }
        row.append(dd);
        list.append(row);
      }
      detailsEl.append(list);
    }

    if (location) {
      const wrap = el("div", "pv-map-wrap");
      const mapEl = el("div", "pv-map");
      mapEl.dataset.lat = String(location.lat);
      mapEl.dataset.lng = String(location.lng);
      mapEl.setAttribute("role", "group");
      mapEl.setAttribute("aria-label", "Map of where this photograph was taken");
      wrap.append(mapEl);
      detailsEl.append(wrap);
    }

    return true;
  }

  function syncDetailsVisibility(hasDetails: boolean): void {
    detailsBtn.hidden = !hasDetails;
    const show = hasDetails && detailsOpen;
    detailsBtn.setAttribute("aria-expanded", String(show));
    detailsBtn.setAttribute("aria-label", show ? "Hide details" : "Show details");
    detailsEl.hidden = !show;
    bodyEl.classList.toggle("pv-has-details", show);
    if (show) {
      mountMap();
    } else {
      unmountMap();
    }
    requestAnimationFrame(resizePhoto);
  }

  function renderPhoto(index: number, thumbnail?: HTMLImageElement): void {
    const photo = photos[index];
    if (!photo) return;
    currentIndex = index;

    statusEl.textContent = `Photo ${index + 1} of ${photos.length}`;
    activeOriginalUrl = photo.original;
    if (activeOriginalUrl) {
      downloadLink.href = activeOriginalUrl;
      downloadLink.removeAttribute("aria-disabled");
    } else {
      downloadLink.removeAttribute("href");
      downloadLink.setAttribute("aria-disabled", "true");
    }

    const caption = photo.caption?.trim() || "";
    captionEl.textContent = caption;
    captionEl.hidden = !caption;

    const hasDetails = renderDetails(photo);
    syncDetailsVisibility(hasDetails);

    refreshWindow();
    const slot = slots.get(index)!;
    if (!slot.displayedImg && thumbnail?.complete && thumbnail.naturalWidth > 0) {
      const image = document.createElement("img");
      image.className = "pv-img";
      image.src = thumbnail.currentSrc || thumbnail.src;
      image.draggable = false;
      slot.displayedImg = image;
      slot.displayedRung = slot.rungs.findIndex(
        (source) => new URL(source.src, document.baseURI).href === image.src
      );
      if (slot.displayedRung >= 0) stopPreview(slot);
    }
    sizeFrame();
    attachSlotToFrame(slot);
    warmPreview(slot);
    void runLadder(slot);
    for (const neighbour of slots.values()) {
      if (neighbour.index !== currentIndex) warmPreview(neighbour);
    }

    if (options.syncImageQuery && dialog.open) {
      const url = new URL(window.location.href);
      if (url.searchParams.get("image") !== photo.id) {
        url.searchParams.set("image", photo.id);
        history.replaceState({ galleryViewer: true, id: photo.id }, "", url.toString());
      }
    }
  }

  function step(delta: number): void {
    if (photos.length < 2) return;
    renderPhoto(mod(currentIndex + delta, photos.length));
  }

  function toggleDetails(): void {
    if (detailsBtn.hidden) return;
    detailsOpen = !detailsOpen;
    syncDetailsVisibility(true);
  }

  function open(id: string, opener?: HTMLElement): void {
    const idx = photoIndexMap.get(id);
    if (idx === undefined) {
      console.warn(`Photograph not found: ${id}`);
      return;
    }

    if (opener) openerElement = opener;
    savedScrollY = window.scrollY;

    const hadImageQuery =
      options.syncImageQuery &&
      new URL(window.location.href).searchParams.get("image") !== null;

    const wasOpen = dialog.open;
    if (!wasOpen) {
      dialog.showModal();
      closeBtn.focus({ preventScroll: true });
    }

    if (options.syncImageQuery) {
      const url = new URL(window.location.href);
      if (url.searchParams.get("image") !== id) {
        url.searchParams.set("image", id);
        if (!hadImageQuery) {
          history.pushState({ galleryViewer: true, id }, "", url.toString());
          openedViaPush = true;
        } else {
          history.replaceState({ galleryViewer: true, id }, "", url.toString());
        }
      }
    }

    renderPhoto(idx, opener?.querySelector("img") ?? undefined);
  }

  function closeInternal(syncHistory: boolean): void {
    if (!dialog.open) return;

    unmountMap();
    detailsOpen = false;
    clearSlots();

    dialog.close();
    document.documentElement.classList.remove("gallery-image-deep-link");

    if (options.syncImageQuery && syncHistory) {
      if (openedViaPush) {
        history.back();
      } else {
        const url = new URL(window.location.href);
        if (url.searchParams.has("image")) {
          url.searchParams.delete("image");
          history.replaceState(null, "", url.toString());
        }
      }
    }
    openedViaPush = false;

    window.scrollTo(0, savedScrollY);

    if (openerElement && typeof openerElement.focus === "function") {
      openerElement.focus();
    } else {
      const heading = document.querySelector("h1");
      if (heading) {
        heading.setAttribute("tabindex", "-1");
        heading.focus();
      }
    }
  }

  function close(): void {
    closeInternal(true);
  }

  // Touch / pointer swipe across the stage.
  let swipe: { id: number; x: number; y: number } | null = null;
  let suppressBackdropClick = false;

  const onStagePointerDown = (e: PointerEvent) => {
    if (!e.isPrimary || e.button !== 0) return;
    if ((window.visualViewport?.scale ?? 1) > 1.01) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest("button, a, .pv-error")) return;
    swipe = { id: e.pointerId, x: e.clientX, y: e.clientY };
  };

  const onStagePointerUp = (e: PointerEvent) => {
    if (!swipe || e.pointerId !== swipe.id) return;
    const dx = e.clientX - swipe.x;
    const dy = e.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) >= SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy) * 1.2) {
      suppressBackdropClick = true;
      step(dx < 0 ? 1 : -1);
      return;
    }
    if (Math.hypot(dx, dy) > DRAG_SLOP) {
      suppressBackdropClick = true;
    }
  };

  const onStagePointerCancel = (e: PointerEvent) => {
    if (swipe?.id === e.pointerId) swipe = null;
  };

  const onStageClick = (e: MouseEvent) => {
    if (suppressBackdropClick) {
      suppressBackdropClick = false;
      return;
    }
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    if (target === stageEl || target === figureEl) {
      close();
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!dialog.open) return;
    const target = e.target instanceof HTMLElement ? e.target : null;
    if (
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable)
    ) {
      return;
    }
    const inMap = target?.closest(".pv-map") != null;

    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowLeft" && !inMap) {
      e.preventDefault();
      step(-1);
    } else if (e.key === "ArrowRight" && !inMap) {
      e.preventDefault();
      step(1);
    } else if (
      (e.key === "i" || e.key === "I" || e.key === "f" || e.key === "F") &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !detailsBtn.hidden
    ) {
      e.preventDefault();
      toggleDetails();
    }
  };

  const onPopState = () => {
    if (!options.syncImageQuery) return;
    const url = new URL(window.location.href);
    const id = url.searchParams.get("image");
    const idx = id === null ? undefined : photoIndexMap.get(id);
    if (idx === undefined) {
      if (dialog.open) closeInternal(false);
    } else if (!dialog.open) {
      dialog.showModal();
      closeBtn.focus({ preventScroll: true });
      renderPhoto(idx);
    } else if (idx !== currentIndex) {
      renderPhoto(idx);
    }
  };

  const onDialogCancel = (e: Event) => {
    e.preventDefault();
    close();
  };

  const resizeObserver = new ResizeObserver(resizePhoto);
  resizeObserver.observe(stageEl);

  const onCloseClick = () => close();
  const onPrevClick = () => step(-1);
  const onNextClick = () => step(1);
  const onDetailsClick = () => toggleDetails();
  const onViewportResize = () => {
    if (dialog.open) {
      resizePhoto();
    }
  };

  closeBtn.addEventListener("click", onCloseClick);
  prevBtn.addEventListener("click", onPrevClick);
  nextBtn.addEventListener("click", onNextClick);
  detailsBtn.addEventListener("click", onDetailsClick);
  stageEl.addEventListener("pointerdown", onStagePointerDown);
  stageEl.addEventListener("pointerup", onStagePointerUp);
  stageEl.addEventListener("pointercancel", onStagePointerCancel);
  stageEl.addEventListener("click", onStageClick);
  window.addEventListener("keydown", onKeyDown);
  dialog.addEventListener("cancel", onDialogCancel);
  window.addEventListener("popstate", onPopState);
  window.visualViewport?.addEventListener("resize", onViewportResize);

  return {
    open,
    close,
    destroy() {
      const shouldClear =
        options.syncImageQuery &&
        new URL(window.location.href).searchParams.has("image");
      if (dialog.open) closeInternal(false);
      if (shouldClear) {
        const url = new URL(window.location.href);
        url.searchParams.delete("image");
        history.replaceState(null, "", url.toString());
      }
      resizeObserver.disconnect();
      closeBtn.removeEventListener("click", onCloseClick);
      prevBtn.removeEventListener("click", onPrevClick);
      nextBtn.removeEventListener("click", onNextClick);
      detailsBtn.removeEventListener("click", onDetailsClick);
      stageEl.removeEventListener("pointerdown", onStagePointerDown);
      stageEl.removeEventListener("pointerup", onStagePointerUp);
      stageEl.removeEventListener("pointercancel", onStagePointerCancel);
      stageEl.removeEventListener("click", onStageClick);
      window.removeEventListener("keydown", onKeyDown);
      dialog.removeEventListener("cancel", onDialogCancel);
      window.removeEventListener("popstate", onPopState);
      window.visualViewport?.removeEventListener("resize", onViewportResize);
      clearSlots();
      unmountMap();
      shell.remove();
    },
  };
}
