import { it } from "node:test";
import assert from "node:assert/strict";
import type { Photo } from "../src/lib/gallery/types";
import { galleryLabel } from "../src/lib/gallery/labels";

it("renders the camera's month and year in gallery captions", () => {
  const photo: Photo = {
    id: "photo123",
    width: 800,
    height: 600,
    alt: "",
    original: "/original.jpg",
    sources: [{ src: "/photo.webp", width: 800, height: 600 }],
    exif: { Date: "2024-02-01T00:30:00+02:00" },
  };
  assert.equal(galleryLabel(photo).title, "Feb 2024");
  assert.equal(galleryLabel({ ...photo, exif: { Date: "not a date" } }).title, "PHOTO1");
});
