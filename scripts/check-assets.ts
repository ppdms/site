import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_FILE_SIZE = 26_214_400; // 25 MiB (Cloudflare Static Assets per-file limit)
const TARGET_DIR = join(dirname(fileURLToPath(import.meta.url)), "../dist");

async function checkDirectory(dir: string): Promise<boolean> {
  let hasViolation = false;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    console.error(`Error reading directory ${dir}:`, err);
    return false;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const subResult = await checkDirectory(fullPath);
      if (!subResult) hasViolation = true;
    } else if (entry.isFile()) {
      const stats = await stat(fullPath);
      if (stats.size > MAX_FILE_SIZE) {
        console.error(
          `Asset size limit exceeded: ${fullPath} is ${stats.size} bytes (maximum allowed: ${MAX_FILE_SIZE} bytes)`
        );
        hasViolation = true;
      }
    }
  }

  return !hasViolation;
}

const ok = await checkDirectory(TARGET_DIR);
if (!ok) {
  process.exit(1);
}
