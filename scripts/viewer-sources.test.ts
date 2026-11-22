import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Photo } from "../src/lib/gallery/types";
import { targetViewerSource, viewerSources } from "../src/lib/viewer-sources";

const photo: Photo = {
  id: "photo",
  width: 3000,
  height: 4000,
  alt: "",
  original: "/original.jpg",
  sources: [320, 640, 1280, 1920, 2560].map((height) => ({
    src: `/${height}.webp`,
    width: height * 3 / 4,
    height,
  })),
};

describe("viewer image selection", () => {
  it("loads a preview and chooses the smallest source for the display", () => {
    const sources = viewerSources(photo);
    assert.equal(sources[0].src, "/640.webp");
    assert.equal(sources[targetViewerSource(photo, sources, 450, 600, 2)].src, "/1280.webp");
  });

  it("uses a larger derivative or the original when zoom requires it", () => {
    const sources = viewerSources(photo);
    assert.equal(sources[targetViewerSource(photo, sources, 450, 600, 4)].src, "/2560.webp");
    assert.equal(sources[targetViewerSource(photo, sources, 450, 600, 8)].src, "/original.jpg");
  });

  it("uses the largest available source when the original is already a derivative", () => {
    const smaller = { ...photo, original: "/2560.webp" };
    const sources = viewerSources(smaller);
    assert.equal(sources.filter((source) => source.src === smaller.original).length, 1);
    assert.equal(sources[targetViewerSource(smaller, sources, 450, 600, 8)].src, "/2560.webp");
  });
});
