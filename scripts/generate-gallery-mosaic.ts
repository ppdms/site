import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { MOSAIC_COLUMNS, MOSAIC_ROWS, mosaicSources } from "../src/lib/gallery/mosaic";
import { parseManifest } from "../src/lib/gallery/types";
import { mapLimit } from "./media";

const CELL = 64;
const GAP = 4;
const sources = mosaicSources(
  parseManifest(JSON.parse(await readFile("src/data/gallery.json", "utf8"))).images
);

const tiles = await mapLimit(sources, 8, async (src, index) => {
  const response = await fetch(src);
  if (!response.ok) throw new Error(`Cannot fetch ${src}: ${response.status} ${response.statusText}`);
  const input = await sharp(Buffer.from(await response.arrayBuffer()))
    .resize(CELL - GAP, CELL - GAP, { fit: "cover" })
    .webp()
    .toBuffer();
  return { input, left: (index % MOSAIC_COLUMNS) * CELL, top: Math.floor(index / MOSAIC_COLUMNS) * CELL };
});

const sprite = await sharp({
  create: {
    width: MOSAIC_COLUMNS * CELL - GAP,
    height: MOSAIC_ROWS * CELL - GAP,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
})
  .composite(tiles)
  .webp({ quality: 80 })
  .toBuffer();

await writeFile("src/content/gallery-mosaic.webp", sprite);
await writeFile("src/data/gallery-mosaic.json", `${JSON.stringify(sources, null, 2)}\n`);
console.log(`Generated gallery mosaic: ${sources.length} photos, ${sprite.length} bytes.`);
