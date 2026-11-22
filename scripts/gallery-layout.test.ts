import { it } from "node:test";
import assert from "node:assert/strict";
import { CAPTION_HEIGHT, computeLayout, computePhotoRows } from "../src/lib/gallery/layout";

it("fills justified rows without cropping or overlapping captions", () => {
  const photos = [
    { width: 3000, height: 4000 },
    { width: 4000, height: 3000 },
    { width: 4000, height: 2000 },
    { width: 2000, height: 3000 },
    { width: 3000, height: 2000 },
  ];
  for (const width of [320, 800, 1200]) {
    const layout = computeLayout(photos, width, width);
    assert.equal(layout.items.length, photos.length);
    for (const [index, item] of layout.items.entries()) {
      const aspect = photos[index].width / photos[index].height;
      assert.ok(Math.abs(item.width / (item.height - CAPTION_HEIGHT) - aspect) < 0.02);
      if (index && layout.items[index - 1].top !== item.top) {
        const previous = layout.items[index - 1];
        assert.equal(previous.left + previous.width, width);
        assert.ok(item.top >= previous.top + previous.height);
      }
    }
    const last = layout.items.at(-1)!;
    assert.equal(last.left + last.width, width);
    assert.equal(layout.height, last.top + last.height);
  }
});

it("handles an empty or unmeasurable sheet", () => {
  assert.deepEqual(computeLayout([], 800, 800), { items: [], height: 0 });
  assert.deepEqual(computePhotoRows([1], 0, 20, { targetArea: 100, maxPhotos: 3 }), []);
});
