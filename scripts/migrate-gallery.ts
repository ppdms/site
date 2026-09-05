import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { parseManifest } from "@ppdms/gallerydeluxe/types";
import type { GalleryManifest, Photo } from "@ppdms/gallerydeluxe/types";
import {
  computeFileMd5,
  mapLimit,
  processImageDerivatives,
  uploadObjectToR2,
  writeManifestAtomically,
  DATA_ORIGIN,
} from "./media.js";

interface CliOptions {
  upload: boolean;
  manifestPath: string;
  oldManifestPath: string;
  outputDir: string;
  start: number;
  limit?: number;
}

function parseCliArgs(args: string[]): CliOptions {
  let upload = false;
  let manifestPath = "static/gallery/gallery.json";
  let oldManifestPath = "static/gallery/gallery.json";
  let outputDir = ".gallery-staging";
  let start = 0;
  let limit: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--upload") {
      upload = true;
    } else if (arg === "--manifest" && i + 1 < args.length) {
      manifestPath = args[++i];
    } else if (arg === "--old-manifest" && i + 1 < args.length) {
      oldManifestPath = args[++i];
    } else if (arg === "--output-dir" && i + 1 < args.length) {
      outputDir = args[++i];
    } else if (arg === "--limit" && i + 1 < args.length) {
      limit = Number(args[++i]);
    } else if (arg === "--start" && i + 1 < args.length) {
      start = Number(args[++i]);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!Number.isInteger(start) || start < 0) {
    throw new Error(`--start must be a non-negative integer, received ${start}`);
  }
  if (
    limit !== undefined &&
    (!Number.isInteger(limit) || limit < 1)
  ) {
    throw new Error(`--limit must be a positive integer, received ${limit}`);
  }

  return { upload, manifestPath, oldManifestPath, outputDir, start, limit };
}

interface OldGalleryRecord {
  500?: string;
  full: string;
  name?: string;
  width: number;
  height: number;
  colors?: string[];
  exif?: Photo["exif"];
}

async function streamDownload(url: string, destPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  }
  if (!response.body) {
    throw new Error(`Empty response body fetching ${url}`);
  }

  const fileStream = createWriteStream(destPath);
  await pipeline(response.body, fileStream);
}

async function getOrDownloadOriginal(
  id: string,
  fullPathInOrigin: string,
  outputDir: string,
  localOriginals: ReadonlyMap<string, string>
): Promise<string> {
  const originalsDir = join(outputDir, "originals");
  await mkdir(originalsDir, { recursive: true });
  const stagedPath = join(originalsDir, `${id}.jpeg`);

  // 1. Check if already staged and valid
  try {
    const s = await stat(stagedPath);
    if (s.isFile() && s.size > 0) {
      const hash = await computeFileMd5(stagedPath);
      if (hash === id) {
        return stagedPath;
      }
    }
  } catch {
    // Not staged yet
  }

  const localMatch = localOriginals.get(id);
  if (localMatch) {
    await copyFile(localMatch, stagedPath);
    return stagedPath;
  }

  // 3. Download from origin
  const remoteUrl = `${DATA_ORIGIN}/${fullPathInOrigin}`;
  const downloadPath = `${stagedPath}.part.${Date.now()}`;
  try {
    console.log(`Downloading original for ${id} from ${remoteUrl}...`);
    await streamDownload(remoteUrl, downloadPath);

    const hash = await computeFileMd5(downloadPath);
    if (hash !== id) {
      await unlink(downloadPath).catch(() => {});
      throw new Error(
        `Corrupt original for ${id}: expected MD5 ${id}, computed ${hash}`
      );
    }

    await rename(downloadPath, stagedPath);
    return stagedPath;
  } catch (err) {
    await unlink(downloadPath).catch(() => {});
    throw err;
  }
}

async function collectLocalJpegs(
  roots: readonly string[]
): Promise<string[]> {
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (
        entry.isFile() &&
        (extname(entry.name).toLowerCase() === ".jpg" ||
          extname(entry.name).toLowerCase() === ".jpeg")
      ) {
        files.push(path);
      }
    }
  }

  for (const root of roots) {
    await visit(root);
  }
  return files.sort();
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  console.log(`Reading old manifest from ${options.oldManifestPath}...`);
  const raw = await readFile(options.oldManifestPath, "utf8");
  const parsedJson = JSON.parse(raw);

  let oldRecords: OldGalleryRecord[];
  if (Array.isArray(parsedJson)) {
    oldRecords = parsedJson as OldGalleryRecord[];
  } else if (parsedJson.version === 1 && Array.isArray(parsedJson.images)) {
    console.log("Manifest is already v1 format. Re-verifying/migrating records...");
    oldRecords = parsedJson.images.map((p: Photo) => ({
      full: `originals/${p.id}.jpeg`,
      width: p.width,
      height: p.height,
      exif: p.exif,
    }));
  } else {
    throw new Error("Unrecognized manifest format");
  }

  const allOldRecords = oldRecords;
  if (options.start > 0 || options.limit !== undefined) {
    const end =
      options.limit === undefined
        ? undefined
        : options.start + options.limit;
    oldRecords = allOldRecords.slice(options.start, end);
  }

  console.log(`Found ${oldRecords.length} gallery records to migrate.`);

  const wranglerBin = resolve(process.cwd(), "node_modules/.bin/wrangler");
  const localJpegPaths = await collectLocalJpegs([
    "originals",
    "gallery-intake",
    "static",
    "content",
    "src/content",
  ]);
  const localOriginals = new Map<string, string>();
  const localHashes = await mapLimit(localJpegPaths, 2, async (filePath) => ({
    filePath,
    id: await computeFileMd5(filePath),
  }));
  for (const { filePath, id } of localHashes) {
    if (!localOriginals.has(id)) {
      localOriginals.set(id, filePath);
    }
  }

  const previousCandidateMap = new Map<string, Photo>();
  if (options.start > 0) {
    const candidatePath = join(options.outputDir, "gallery.json");
    try {
      const candidate = parseManifest(JSON.parse(await readFile(candidatePath, "utf8")));
      for (const photo of candidate.images) {
        previousCandidateMap.set(photo.id, photo);
      }
    } catch {
      throw new Error(
        `Cannot resume from ${candidatePath}: a valid staged manifest is required when --start is used`
      );
    }
  }

  // Concurrency bounded to 2
  const processedPhotos = await mapLimit(oldRecords, 2, async (record, index) => {
    const match = record.full.match(/([a-f0-9]{32})/i);
    if (!match) {
      throw new Error(`Could not extract MD5 ID from record.full: ${record.full}`);
    }
    const id = match[1].toLowerCase();

    console.log(`[${index + 1}/${oldRecords.length}] Processing ${id}...`);
    const originalPath = await getOrDownloadOriginal(
      id,
      record.full,
      options.outputDir,
      localOriginals
    );

    const processed = await processImageDerivatives(
      originalPath,
      id,
      options.outputDir,
      record.exif
    );

    if (options.upload) {
      for (const file of processed.generatedFiles) {
        console.log(`Uploading ${file.key}...`);
        await uploadObjectToR2(
          wranglerBin,
          file.key,
          file.filePath,
          file.contentType,
          file.cacheControl
        );
      }
    }

    return processed.photo;
  });

  const processedById = new Map<string, Photo>([
    ...[...previousCandidateMap.entries()],
    ...processedPhotos.map((photo) => [photo.id, photo] as const),
  ]);
  const outputRecords =
    options.start > 0 ? allOldRecords : oldRecords;
  const migratedPhotos = outputRecords.map((record) => {
    const match = record.full.match(/([a-f0-9]{32})/i);
    if (!match) {
      throw new Error(`Could not extract MD5 ID from record.full: ${record.full}`);
    }
    const id = match[1].toLowerCase();
    const photo = processedById.get(id);
    if (!photo) {
      throw new Error(`Staged migration is missing photo ${id}`);
    }
    return photo;
  });

  const candidateManifest: GalleryManifest = {
    version: 1,
    images: migratedPhotos,
  };

  // Validate resulting manifest
  parseManifest(candidateManifest);
  console.log(`Successfully migrated and validated ${candidateManifest.images.length} photos.`);

  if (options.upload) {
    console.log(`Publishing validated manifest to ${options.manifestPath}...`);
    await writeManifestAtomically(options.manifestPath, candidateManifest);
    console.log(`Migration published to ${options.manifestPath} successfully.`);
  } else {
    const candidatePath = join(options.outputDir, "gallery.json");
    console.log(`Writing staged candidate manifest to ${candidatePath}...`);
    await writeManifestAtomically(candidatePath, candidateManifest);
    console.log("Staged migration complete. Live manifest unchanged.");
  }
}

main().catch((err) => {
  console.error("gallery:migrate failed:", err);
  process.exit(1);
});
