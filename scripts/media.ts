import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import exifr from "exifr";
import type { GalleryManifest, ImageSource, Photo } from "@ppdms/gallerydeluxe/types";

const execFileAsync = promisify(execFile);

export const LONG_EDGES = [320, 640, 960, 1280, 1920, 2560] as const;
export const WEBP_QUALITY = 82;
export const DATA_ORIGIN = "https://data.ppdms.gr";
export const CACHE_CONTROL_IMMUTABLE = "public, max-age=31536000, immutable";

export interface GeneratedDerivative {
  filePath: string;
  key: string;
  contentType: string;
  cacheControl: string;
  width: number;
  height: number;
}

export interface ProcessedMediaResult {
  photo: Photo;
  generatedFiles: GeneratedDerivative[];
}

/**
 * Computes MD5 of a file by streaming its bytes.
 */
export function computeFileMd5(filePath: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const hash = createHash("md5");
  const stream = createReadStream(filePath);
  stream.on("data", (chunk) => hash.update(chunk));
  stream.on("end", () => resolve(hash.digest("hex")));
  stream.on("error", reject);
  return promise;
}

/**
 * Extracts normalized EXIF data using exifr.
 * Preserves recorded dates/offsets without inventing timezones;
 * accepts legitimate zero latitude or longitude values, but omits the
 * `(0, 0)` no-fix sentinel emitted by cameras without a GPS lock.
 */
export async function extractExif(filePath: string): Promise<Photo["exif"] | undefined> {
  try {
    const rawValue: unknown = await exifr.parse(filePath, {
      tiff: true,
      xmp: true,
      gps: true,
      exif: true,
    });

    if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
      return undefined;
    }
    const raw = rawValue as Record<string, unknown>;

    const exif: Photo["exif"] = {};

    // Date
    const dateValue = raw.DateTimeOriginal ?? raw.CreateDate;
    const dateOffset = raw.OffsetTimeOriginal ?? raw.OffsetTime;
    if (typeof dateValue === "string" && dateValue.trim()) {
      exif.Date = dateValue.trim();
    } else if (dateValue instanceof Date && !Number.isNaN(dateValue.getTime())) {
      const offset =
        typeof dateOffset === "string" && /^[+-]\d{2}:\d{2}$/.test(dateOffset)
          ? dateOffset
          : undefined;
      if (offset) {
        const sign = offset.startsWith("-") ? -1 : 1;
        const offsetMinutes =
          sign *
          (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
        const localDate = new Date(dateValue.getTime() + offsetMinutes * 60_000);
        const isoLocal = localDate.toISOString().slice(0, 19);
        exif.Date = `${isoLocal}${offset}`;
      } else {
        exif.Date = dateValue.toISOString();
      }
    }

    // Coordinates. Cameras commonly encode "no GPS fix" as (0, 0).
    const latitude =
      typeof raw.latitude === "number" && Number.isFinite(raw.latitude)
        ? raw.latitude
        : undefined;
    const longitude =
      typeof raw.longitude === "number" && Number.isFinite(raw.longitude)
        ? raw.longitude
        : undefined;
    if (
      latitude !== undefined &&
      longitude !== undefined &&
      (latitude !== 0 || longitude !== 0)
    ) {
      exif.Lat = latitude;
      exif.Long = longitude;
    }

    // Camera/lens tags
    const tags: Record<string, string | number> = {};
    if (raw.ExposureTime !== undefined && raw.ExposureTime !== null) {
      if (typeof raw.ExposureTime === "number" && Number.isFinite(raw.ExposureTime)) {
        if (raw.ExposureTime < 1 && raw.ExposureTime > 0) {
          const denominator = Math.round(1 / raw.ExposureTime);
          tags.ExposureTime = `1/${denominator}`;
        } else {
          tags.ExposureTime = String(raw.ExposureTime);
        }
      } else if (typeof raw.ExposureTime === "string") {
        tags.ExposureTime = raw.ExposureTime;
      }
    }

    if (raw.FNumber !== undefined && raw.FNumber !== null) {
      if (typeof raw.FNumber === "number" && Number.isFinite(raw.FNumber)) {
        tags.FNumber = String(raw.FNumber);
      } else if (typeof raw.FNumber === "string") {
        tags.FNumber = raw.FNumber;
      }
    }

    if (raw.FocalLengthIn35mmFormat !== undefined && raw.FocalLengthIn35mmFormat !== null) {
      const num = Number(raw.FocalLengthIn35mmFormat);
      if (Number.isFinite(num)) {
        tags.FocalLengthIn35mmFormat = Math.round(num);
      }
    }

    if (raw.ISO !== undefined && raw.ISO !== null) {
      const iso = Number(raw.ISO);
      if (Number.isFinite(iso)) {
        tags.ISO = Math.round(iso);
      }
    }

    if (typeof raw.LensModel === "string" && raw.LensModel.trim()) {
      tags.LensModel = raw.LensModel.trim();
    }

    if (Object.keys(tags).length > 0) {
      exif.Tags = tags;
    }

    if (exif.Date !== undefined || exif.Lat !== undefined || exif.Long !== undefined || exif.Tags !== undefined) {
      return exif;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Normalizes an image (orientation, sRGB) and generates responsive WebP derivatives sequentially.
 * No upscaling is performed; identical dimensions for small originals are deduplicated.
 * Strips metadata.
 */
export async function processImageDerivatives(
  inputPath: string,
  id: string,
  outputDir: string,
  existingExif?: Photo["exif"]
): Promise<ProcessedMediaResult> {
  // Read initial metadata after orientation normalization
  const meta = await sharp(inputPath).metadata();

  if (!meta.width || !meta.height) {
    throw new Error(`Could not determine dimensions for image ${inputPath}`);
  }

  const isOrientationSwapped =
    meta.orientation !== undefined &&
    meta.orientation >= 5 &&
    meta.orientation <= 8;
  const normWidth = isOrientationSwapped ? meta.height : meta.width;
  const normHeight = isOrientationSwapped ? meta.width : meta.height;
  const origLongEdge = Math.max(normWidth, normHeight);

  const generatedFiles: GeneratedDerivative[] = [];
  const sourcesMap = new Map<string, ImageSource>(); // keyed by dimensions to deduplicate

  const imageMediaDir = join(outputDir, "gallery-media", "v1", id);
  await mkdir(imageMediaDir, { recursive: true });

  // Generate derivatives sequentially
  for (const targetEdge of LONG_EDGES) {
    // If targetEdge is greater than original long edge and we already generated the full-size derivative, skip
    if (targetEdge >= origLongEdge && sourcesMap.size > 0 && Array.from(sourcesMap.values()).some((s) => Math.max(s.width, s.height) === origLongEdge)) {
      continue;
    }

    const isLandscape = normWidth >= normHeight;
    const resizeOptions = isLandscape
      ? { width: Math.min(targetEdge, normWidth), withoutEnlargement: true }
      : { height: Math.min(targetEdge, normHeight), withoutEnlargement: true };

    const expectedLongEdge = Math.min(targetEdge, origLongEdge);
    const outFileName = `${expectedLongEdge}.webp`;
    const outFilePath = join(imageMediaDir, outFileName);

    let info: { width: number; height: number };
    try {
      const existing = await sharp(outFilePath).metadata();
      const existingStats = await stat(outFilePath);
      if (
        existingStats.size > 0 &&
        existing.format === "webp" &&
        existing.width &&
        existing.height &&
        Math.max(existing.width, existing.height) === expectedLongEdge
      ) {
        info = { width: existing.width, height: existing.height };
      } else {
        throw new Error("staged derivative is not a usable WebP");
      }
    } catch {
      // Process derivative with Sharp (strips metadata by default)
      const generated = await sharp(inputPath)
        .rotate()
        .resize(resizeOptions)
        .toColorspace("srgb")
        .webp({ quality: WEBP_QUALITY })
        .toFile(outFilePath);
      info = { width: generated.width, height: generated.height };
    }

    const actualLongEdge = Math.max(info.width, info.height);
    const key = `gallery-media/v1/${id}/${actualLongEdge}.webp`;

    // If an image with these exact dimensions already exists, keep only the first
    const dimensionsKey = `${info.width}x${info.height}`;
    if (!sourcesMap.has(dimensionsKey)) {
      sourcesMap.set(dimensionsKey, {
        src: `${DATA_ORIGIN}/${key}`,
        width: info.width,
        height: info.height,
      });

      generatedFiles.push({
        filePath: outFilePath,
        key,
        contentType: "image/webp",
        cacheControl: CACHE_CONTROL_IMMUTABLE,
        width: info.width,
        height: info.height,
      });
    }
  }

  // Ensure sources are sorted strictly by increasing width
  const sources = Array.from(sourcesMap.values()).sort((a, b) => a.width - b.width);

  const exif = existingExif ?? (await extractExif(inputPath));

  const photo: Photo = {
    id,
    width: normWidth,
    height: normHeight,
    alt: "",
    original: `${DATA_ORIGIN}/originals/${id}.jpeg`,
    sources,
    exif,
  };

  return {
    photo,
    generatedFiles,
  };
}

/**
 * Uploads an object to Cloudflare R2 using the local Wrangler executable.
 */
export async function uploadObjectToR2(
  wranglerBin: string,
  key: string,
  filePath: string,
  contentType: string,
  cacheControl: string
): Promise<void> {
  await execFileAsync(wranglerBin, [
    "r2",
    "object",
    "put",
    `data/${key}`,
    "--file",
    filePath,
    "--remote",
    "--content-type",
    contentType,
    "--cache-control",
    cacheControl,
  ]);
}

/**
 * Concurrency limiter to bound parallel operations (e.g. max 2 images at a time).
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Concurrency limit must be a positive integer, received ${limit}`);
  }
  const results = new Array<R>(items.length);
  let currentIndex = 0;

  async function worker() {
    while (currentIndex < items.length) {
      const idx = currentIndex++;
      results[idx] = await fn(items[idx], idx);
    }
  }

  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Atomically writes manifest via temporary sibling file + rename.
 */
export async function writeManifestAtomically(
  manifestPath: string,
  manifest: GalleryManifest
): Promise<void> {
  const dir = dirname(manifestPath);
  await mkdir(dir, { recursive: true });
  const tmpPath = `${manifestPath}.tmp.${process.pid}.${randomUUID()}`;
  await writeFile(tmpPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await rename(tmpPath, manifestPath);
}
