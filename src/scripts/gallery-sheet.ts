import { arrangeSheet } from "../lib/gallery/runtime";

/**
 * Inlined immediately after the contact sheet, so the arrangement for this
 * visit is decided before the visitor can see anything.
 *
 * The sheet is hidden until this runs. If arranging it fails, the `gallery-js` flag
 * is dropped instead of revealing a half-placed sheet: that restores the
 * stylesheet's own flowing layout, which needs no script at all.
 */
const container = document.getElementById("gallery-sheet");

if (container) {
  try {
    arrangeSheet(container);
  } catch (error) {
    document.documentElement.classList.remove("gallery-js");
    console.error("Gallery sheet could not be arranged", error);
  }

  // The photo viewer arrives with the page's module script. Until then a tap
  // would follow the cell's raw image link and leave the page, so it is held
  // back. Module scripts run before `DOMContentLoaded`, so that event is the
  // exact point after which the viewer is either wired up or never will be —
  // and links go back to being ordinary links.
  const holdClicks = (event: MouseEvent) => {
    if (container.hasAttribute("data-viewer-ready")) return;
    const target = event.target;
    if (target instanceof Element && target.closest(".gallery-photo-link")) {
      event.preventDefault();
    }
  };

  container.addEventListener("click", holdClicks, true);
  document.addEventListener(
    "DOMContentLoaded",
    () => container.removeEventListener("click", holdClicks, true),
    { once: true }
  );
}
