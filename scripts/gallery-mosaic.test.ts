import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Photo } from "../src/lib/gallery/types";
import { mosaicSources } from "../src/lib/gallery/mosaic";

function photo(index: number): Photo {
  return {
    id: String(index),
    width: 100,
    height: 100,
    alt: "",
    original: `/original-${index}.jpg`,
    sources: [{ src: `/thumbnail-${index}.webp`, width: 100, height: 100 }],
  };
}

describe("homepage mosaic", () => {
  it("samples the whole gallery in manifest order", () => {
    const photos = Array.from({ length: 192 }, (_, index) => photo(index));
    assert.deepEqual(mosaicSources(photos), Array.from({ length: 96 }, (_, index) => `/thumbnail-${index * 2}.webp`));
  });

  it("handles small and empty galleries, including photos without derivatives", () => {
    const photos = [photo(0), { ...photo(1), sources: [] }];
    assert.deepEqual(mosaicSources(photos), ["/thumbnail-0.webp", "/original-1.jpg"]);
    assert.deepEqual(mosaicSources([]), []);
  });
});
