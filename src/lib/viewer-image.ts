import type { Photo } from "./gallery/types";

/** Load and decode before exposing an image; cancellation also releases its request. */
export function startImageLoad(
  src: string,
  photo: Photo,
  priority: "high" | "low" | "auto",
  host: HTMLElement
): { promise: Promise<HTMLImageElement>; cancel: () => void } {
  const image = document.createElement("img");
  image.className = "pv-img";
  image.alt = "";
  image.setAttribute("aria-hidden", "true");
  image.draggable = false;
  image.decoding = "async";
  image.fetchPriority = priority;
  image.width = photo.width;
  image.height = photo.height;

  let settled = false;
  let rejectFn: ((reason?: unknown) => void) | null = null;

  const promise = new Promise<HTMLImageElement>((resolve, reject) => {
    rejectFn = reject;
    const settle = async () => {
      if (settled) return;
      try {
        if (typeof image.decode === "function") {
          await image.decode();
        }
      } catch {
        if (settled) return;
        settled = true;
        image.remove();
        reject(new Error(`Image failed to decode: ${src}`));
        return;
      }
      if (settled) return;
      settled = true;
      if (image.naturalWidth > 0) {
        resolve(image);
      } else {
        image.remove();
        reject(new Error(`Image failed to decode: ${src}`));
      }
    };

    image.addEventListener("load", () => void settle(), { once: true });
    image.addEventListener(
      "error",
      () => {
        if (settled) return;
        settled = true;
        image.remove();
        reject(new Error(`Image failed to load: ${src}`));
      },
      { once: true }
    );

    image.src = src;
    host.append(image);

    if (image.complete && image.naturalWidth > 0) {
      void settle();
    }
  });

  const cancel = () => {
    if (settled) return;
    settled = true;
    image.removeAttribute("src");
    image.remove();
    rejectFn?.(new Error("Cancelled"));
  };

  return { promise, cancel };
}
