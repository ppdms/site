import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve, extname } from "node:path";
import { parseManifest } from "@ppdms/gallerydeluxe/types";
import type { GalleryManifest, Photo } from "@ppdms/gallerydeluxe/types";
import {
  computeFileMd5,
  mapLimit,
  processImageDerivatives,
  uploadObjectToR2,
  writeManifestAtomically,
  CACHE_CONTROL_IMMUTABLE,
} from "./media.js";

interface CliOptions {
  inputs: string[];
  upload: boolean;
  manifestPath: string;
  outputDir: string;
}

function parseCliArgs(args: string[]): CliOptions {
  const inputs: string[] = [];
  let upload = false;
  let manifestPath = "static/gallery/gallery.json";
  let outputDir = ".gallery-staging";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--upload") {
      upload = true;
    } else if (arg === "--manifest" && i + 1 < args.length) {
      manifestPath = args[++i];
    } else if (arg === "--output-dir" && i + 1 < args.length) {
      outputDir = args[++i];
    } else if (!arg.startsWith("--")) {
      inputs.push(arg);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (inputs.length === 0) {
    throw new Error(
      "Usage: npm run gallery:add -- <file-or-directory>... [--upload] [--manifest <path>] [--output-dir <path>]"
    );
  }

  return { inputs, upload, manifestPath, outputDir };
}

async function collectJpegFiles(targets: string[]): Promise<string[]> {
  const result: string[] = [];

  async function collectDirectory(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await collectDirectory(entryPath);
        continue;
      }
      if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (ext === ".jpg" || ext === ".jpeg") {
          result.push(entryPath);
        }
      }
    }
  }

  for (const target of targets) {
    const s = await stat(target);
    if (s.isDirectory()) {
      await collectDirectory(target);
    } else if (s.isFile()) {
      const ext = extname(target).toLowerCase();
      if (ext !== ".jpg" && ext !== ".jpeg") {
        throw new Error(
          `Unsupported file format for ${target}: only JPEG (.jpg, .jpeg) is accepted.`
        );
      }
      result.push(target);
    }
  }

  result.sort();
  return result;
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const jpegFiles = await collectJpegFiles(options.inputs);

  if (jpegFiles.length === 0) {
    console.log("No JPEG files found to process.");
    return;
  }

  console.log(`Found ${jpegFiles.length} candidate JPEG files.`);

  // Load existing v1 manifest if present. A malformed manifest must not be
  // silently replaced by a partial candidate.
  let existingManifest: GalleryManifest = { version: 1, images: [] };
  try {
    const raw = await readFile(options.manifestPath, "utf8");
    existingManifest = parseManifest(JSON.parse(raw));
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as { code?: unknown }).code
        : undefined;
    if (code !== "ENOENT") {
      throw err;
    }
    console.log(`No existing manifest at ${options.manifestPath}; starting fresh.`);
  }

  const existingPhotoMap = new Map<string, Photo>();
  for (const photo of existingManifest.images) {
    existingPhotoMap.set(photo.id, photo);
  }

  // Deduplicate input files by MD5
  const seenBatchIds = new Set<string>();
  interface UniqueInput {
    id: string;
    filePath: string;
  }
  const uniqueInputs: UniqueInput[] = [];

  for (const file of jpegFiles) {
    const id = await computeFileMd5(file);
    if (seenBatchIds.has(id)) {
      console.log(`Skipping duplicate within batch: ${file} (id: ${id})`);
      continue;
    }
    seenBatchIds.add(id);
    uniqueInputs.push({ id, filePath: file });
  }

  console.log(`Processing ${uniqueInputs.length} unique images with max concurrency 2...`);

  const wranglerBin = resolve(process.cwd(), "node_modules/.bin/wrangler");

  // Process images (max 2 concurrently, derivative sizes processed sequentially in processImageDerivatives)
  const newlyAddedPhotos: Photo[] = [];

  const processedResults = await mapLimit(uniqueInputs, 2, async ({ id, filePath }) => {
    console.log(`Processing image ${id} (${filePath})...`);
    const processed = await processImageDerivatives(filePath, id, options.outputDir);
    const existingPhoto = existingPhotoMap.get(id);
    const photo: Photo = {
      ...processed.photo,
      alt: existingPhoto?.alt ?? "",
      ...(existingPhoto?.caption !== undefined
        ? { caption: existingPhoto.caption }
        : {}),
      exif: existingPhoto?.exif ?? processed.photo.exif,
    };

    if (options.upload) {
      console.log(`Uploading original for ${id}...`);
      await uploadObjectToR2(
        wranglerBin,
        `originals/${id}.jpeg`,
        filePath,
        "image/jpeg",
        CACHE_CONTROL_IMMUTABLE
      );

      for (const file of processed.generatedFiles) {
        console.log(`Uploading derivative ${file.key}...`);
        await uploadObjectToR2(
          wranglerBin,
          file.key,
          file.filePath,
          file.contentType,
          file.cacheControl
        );
      }
    }

    return { id, photo };
  });

  // Preserve existing records and prepend newly added IDs
  for (const { id, photo } of processedResults) {
    if (!existingPhotoMap.has(id)) {
      newlyAddedPhotos.push(photo);
    } else {
      // Update existing photo record with responsive sources
      existingPhotoMap.set(id, photo);
    }
  }

  const updatedImages: Photo[] = [
    ...newlyAddedPhotos,
    ...existingManifest.images.map((img) => existingPhotoMap.get(img.id) || img),
  ];

  const candidateManifest: GalleryManifest = {
    version: 1,
    images: updatedImages,
  };

  // Validate candidate manifest
  parseManifest(candidateManifest);

  if (options.upload) {
    console.log(`Publishing authoritative manifest to ${options.manifestPath}...`);
    await writeManifestAtomically(options.manifestPath, candidateManifest);
    console.log(`Successfully published manifest with ${updatedImages.length} images.`);
  } else {
    const candidatePath = join(options.outputDir, "gallery.json");
    console.log(`Staging complete. Candidate manifest written to ${candidatePath}`);
    await writeManifestAtomically(candidatePath, candidateManifest);
  }
}

main().catch((err) => {
  console.error("gallery:add failed:", err);
  process.exit(1);
});
