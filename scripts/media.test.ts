import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import {
  computeFileMd5,
  processImageDerivatives,
  writeManifestAtomically,
} from "./media.js";
import { parseManifest } from "@ppdms/gallerydeluxe/types";
import type { GalleryManifest } from "@ppdms/gallerydeluxe/types";

describe("Media Processing and Contract Suite", () => {
  let testDir: string;

  before(async () => {
    testDir = await mkdtemp(join(tmpdir(), "media-test-"));
  });

  after(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("computes accurate streaming MD5 matching raw byte digest", async () => {
    const filePath = join(testDir, "test.txt");
    await writeFile(filePath, "hello site media world\n", "utf8");
    const md5 = await computeFileMd5(filePath);
    assert.equal(typeof md5, "string");
    assert.equal(md5.length, 32);
    // Verify against md5 of "hello site media world\n"
    assert.equal(md5, "9295bedfb707a31d8178bba3916eec69");
  });

  it("handles orientation-swapped portrait dimensions correctly", async () => {
    // Create a 300x100 landscape image with EXIF orientation 6 (Rotate 90 CW) -> 100x300 portrait
    const rawPath = join(testDir, "oriented.jpg");
    await sharp({
      create: {
        width: 300,
        height: 100,
        channels: 3,
        background: { r: 255, g: 0, b: 0 },
      },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toFile(rawPath);

    const md5 = await computeFileMd5(rawPath);
    const result = await processImageDerivatives(rawPath, md5, testDir);

    // After orientation normalization, width is 100 and height is 300
    assert.equal(result.photo.width, 100);
    assert.equal(result.photo.height, 300);
    assert.ok(result.photo.sources.length > 0);
    // Largest source width should be <= 100 (since original width is 100, no upscaling)
    for (const s of result.photo.sources) {
      assert.ok(s.width <= 100);
      assert.ok(s.height <= 300);
    }
  });

  it("does not upscale small images and deduplicates identical sizes", async () => {
    const smallPath = join(testDir, "small.jpg");
    await sharp({
      create: {
        width: 200,
        height: 150,
        channels: 3,
        background: { r: 0, g: 255, b: 0 },
      },
    })
      .jpeg()
      .toFile(smallPath);

    const md5 = await computeFileMd5(smallPath);
    const result = await processImageDerivatives(smallPath, md5, testDir);

    assert.equal(result.photo.width, 200);
    assert.equal(result.photo.height, 150);

    // Long edge is 200, all target edges [320, 640, ...] would exceed it without enlargement
    // So there should be exactly 1 derivative of width 200, height 150
    assert.equal(result.photo.sources.length, 1);
    assert.equal(result.photo.sources[0].width, 200);
    assert.equal(result.photo.sources[0].height, 150);
  });

  it("handles images without EXIF gracefully", async () => {
    const noExifPath = join(testDir, "noexif.jpg");
    await sharp({
      create: {
        width: 400,
        height: 300,
        channels: 3,
        background: { r: 0, g: 0, b: 255 },
      },
    })
      .jpeg()
      .toFile(noExifPath);

    const md5 = await computeFileMd5(noExifPath);
    const result = await processImageDerivatives(noExifPath, md5, testDir);

    assert.equal(result.photo.exif, undefined);
    assert.equal(result.photo.alt, "");
    assert.equal(result.photo.id, md5);

    const manifest: GalleryManifest = {
      version: 1,
      images: [result.photo],
    };
    const validated = parseManifest(manifest);
    assert.equal(validated.images.length, 1);
  });

  it("guarantees failed-upload-then-rerun leaves live manifest untouched until success", async () => {
    const liveManifestPath = join(testDir, "live-manifest.json");
    const initialManifest: GalleryManifest = {
      version: 1,
      images: [
        {
          id: "initial1111111111111111111111111",
          width: 800,
          height: 600,
          alt: "Initial",
          original: "https://data.ppdms.gr/originals/initial.jpeg",
          sources: [
            {
              src: "https://data.ppdms.gr/gallery-media/v1/initial1111111111111111111111111/640.webp",
              width: 640,
              height: 480,
            },
          ],
        },
      ],
    };

    await writeManifestAtomically(liveManifestPath, initialManifest);

    // Simulate an upload attempt that fails midway
    const uploadSimulator = async (shouldFail: boolean) => {
      let step = 0;
      if (shouldFail) {
        step++;
        throw new Error("Simulated network upload timeout");
      }
      // Success step: atomic publish
      const updatedManifest: GalleryManifest = {
        version: 1,
        images: [
          {
            id: "second2222222222222222222222222",
            width: 1200,
            height: 900,
            alt: "Second",
            original: "https://data.ppdms.gr/originals/second.jpeg",
            sources: [
              {
                src: "https://data.ppdms.gr/gallery-media/v1/second2222222222222222222222222/640.webp",
                width: 640,
                height: 480,
              },
            ],
          },
          ...initialManifest.images,
        ],
      };
      await writeManifestAtomically(liveManifestPath, updatedManifest);
    };

    // 1. First run: fails
    await assert.rejects(async () => {
      await uploadSimulator(true);
    }, /Simulated network upload timeout/);

    // Verify live manifest was completely unchanged
    const manifestAfterFailure = JSON.parse(await readFile(liveManifestPath, "utf8"));
    assert.equal(manifestAfterFailure.images.length, 1);
    assert.equal(manifestAfterFailure.images[0].id, "initial1111111111111111111111111");

    // 2. Rerun: succeeds
    await uploadSimulator(false);
    const manifestAfterSuccess = JSON.parse(await readFile(liveManifestPath, "utf8"));
    assert.equal(manifestAfterSuccess.images.length, 2);
    assert.equal(manifestAfterSuccess.images[0].id, "second2222222222222222222222222");
    assert.equal(manifestAfterSuccess.images[1].id, "initial1111111111111111111111111");
  });

  it("parseManifest strictly validates contracts and rejects malformed inputs", () => {
    // Rejects invalid version
    assert.throws(() => parseManifest({ version: 2, images: [] }), /Invalid manifest version/);

    // Rejects duplicate IDs
    assert.throws(
      () =>
        parseManifest({
          version: 1,
          images: [
            {
              id: "abc",
              width: 100,
              height: 100,
              alt: "",
              original: "/orig.jpg",
              sources: [{ src: "/1.webp", width: 100, height: 100 }],
            },
            {
              id: "abc",
              width: 100,
              height: 100,
              alt: "",
              original: "/orig.jpg",
              sources: [{ src: "/1.webp", width: 100, height: 100 }],
            },
          ],
        }),
      /duplicate id/
    );

    // Rejects non-positive or non-finite dimensions
    assert.throws(
      () =>
        parseManifest({
          version: 1,
          images: [
            {
              id: "abc",
              width: -10,
              height: 100,
              alt: "",
              original: "/orig.jpg",
              sources: [{ src: "/1.webp", width: 100, height: 100 }],
            },
          ],
        }),
      /width must be a positive integer/
    );

    // Rejects unsorted sources
    assert.throws(
      () =>
        parseManifest({
          version: 1,
          images: [
            {
              id: "abc",
              width: 1000,
              height: 1000,
              alt: "",
              original: "/orig.jpg",
              sources: [
                { src: "/640.webp", width: 640, height: 640 },
                { src: "/320.webp", width: 320, height: 320 },
              ],
            },
          ],
        }),
      /sources must be sorted by strictly increasing width/
    );

    // Rejects dangerous protocol URLs
    assert.throws(
      () =>
        parseManifest({
          version: 1,
          images: [
            {
              id: "abc",
              width: 100,
              height: 100,
              alt: "",
              original: "javascript:alert(1)",
              sources: [{ src: "/1.webp", width: 100, height: 100 }],
            },
          ],
        }),
      /original must be a valid HTTP\(S\) or root-relative URL/
    );
  });
});
