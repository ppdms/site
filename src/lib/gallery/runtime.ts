import { computeLayout } from "./layout";

const orderKey = "gallery-order-v1";

/** Shuffle once per tab, keeping DOM, keyboard and viewer order in sync. */
function orderPhotos(list: HTMLElement): HTMLElement[] {
  const items = Array.from(list.querySelectorAll<HTMLElement>(".gallery-photo"));
  const byId = new Map(items.map((item) => [item.dataset.id!, item]));
  let ordered: HTMLElement[] = [];
  try {
    const ids: unknown = JSON.parse(sessionStorage.getItem(orderKey) || "null");
    if (Array.isArray(ids) && ids.length === items.length && new Set(ids).size === items.length) {
      ordered = ids.map((id) => byId.get(id)).filter((item): item is HTMLElement => !!item);
    }
  } catch {
    // Storage is optional, including in private browsing.
  }
  if (ordered.length !== items.length) {
    ordered = items.slice();
    for (let i = ordered.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
    }
    try {
      sessionStorage.setItem(orderKey, JSON.stringify(ordered.map((item) => item.dataset.id)));
    } catch {
      // The sheet still works without storage.
    }
  }
  const fragment = document.createDocumentFragment();
  ordered.forEach((item, index) => {
    const link = item.querySelector<HTMLAnchorElement>("[data-label-auto]");
    if (link) link.setAttribute("aria-label", `Open photo ${index + 1} of ${ordered.length}`);
    fragment.append(item);
  });
  list.append(fragment);
  return ordered;
}

/** Arrange synchronously before the sheet is revealed, and again on resize. */
export function arrangeSheet(container: HTMLElement): void {
  const list = container.querySelector<HTMLElement>(".gallery-photo-list");
  if (!list) return;
  const items = orderPhotos(list);
  const photos = items.map((item) => ({
    width: Number(item.dataset.width),
    height: Number(item.dataset.height),
  }));
  let lastWidth = 0;

  function place(): void {
    const width = container.clientWidth;
    if (!width) return;
    lastWidth = width;
    const layout = computeLayout(photos, width, window.innerWidth);
    container.style.height = `${layout.height}px`;
    for (let i = 0; i < items.length; i++) {
      const { left, top, width, height } = layout.items[i];
      const item = items[i];
      Object.assign(item.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
      const image = item.querySelector<HTMLImageElement>(".gallery-photo-image");
      if (image) {
        image.sizes = `${width}px`;
        image.fetchPriority = top < window.innerHeight ? "high" : "low";
      }
    }
    container.dataset.ready = "";
  }

  place();
  if (!lastWidth) document.documentElement.classList.remove("gallery-js");
  new ResizeObserver(([entry]) => {
    if (entry.contentRect.width > 0 && Math.abs(entry.contentRect.width - lastWidth) >= 1) place();
  }).observe(container);
}

/** Mark loaded images and offer a retry when a thumbnail fails. */
export function watchGalleryImages(container: HTMLElement): void {
  function update(image: HTMLImageElement): void {
    const item = image.closest<HTMLElement>(".gallery-photo");
    if (!item || !image.complete) return;
    if (image.naturalWidth) {
      image.classList.add("is-loaded");
      return;
    }
    if (item.querySelector(".gallery-photo-error")) return;
    const link = image.closest<HTMLAnchorElement>(".gallery-photo-link");
    if (!link) return;
    link.hidden = true;
    const message = document.createElement("div");
    message.className = "gallery-photo-error";
    const text = document.createElement("span");
    text.textContent = "Photograph unavailable";
    const retry = document.createElement("button");
    retry.className = "gallery-photo-retry";
    retry.type = "button";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => {
      message.remove();
      link.hidden = false;
      const src = image.getAttribute("src");
      const srcset = image.getAttribute("srcset");
      image.removeAttribute("src");
      image.removeAttribute("srcset");
      if (srcset) image.setAttribute("srcset", srcset);
      if (src) image.setAttribute("src", src);
    });
    message.append(text, retry);
    item.append(message);
  }

  for (const event of ["load", "error"]) {
    container.addEventListener(event, (event) => {
      if (event.target instanceof HTMLImageElement && event.target.matches(".gallery-photo-image")) {
        update(event.target);
      }
    }, true);
  }
  container.dataset.enhanced = "";
  container.querySelectorAll<HTMLImageElement>(".gallery-photo-image").forEach(update);
}
