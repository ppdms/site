import { readFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import YAML from "yaml";
import puppeteer from "puppeteer";
import type { Page } from "puppeteer";

async function fetchTitle(page: Page, url: string): Promise<string> {
  console.log(`Fetching title for ${url}...`);
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  const title = (await page.title()).trim();
  if (!title) {
    throw new Error("Page returned an empty title");
  }
  return title;
}

async function main() {
  const filePath = resolve(process.argv[2] || "src/data/backlinks.yaml");
  console.log(`Processing backlinks in ${filePath}...`);

  const content = await readFile(filePath, "utf8");
  const doc = YAML.parseDocument(content);

  const entries = doc.get("entries") as YAML.YAMLSeq | undefined;
  if (!entries || !YAML.isSeq(entries)) {
    console.log("No entries found in backlinks file.");
    return;
  }

  interface MissingTitleTarget {
    url: string;
    itemMap: YAML.YAMLMap;
  }

  const targets: MissingTitleTarget[] = [];

  for (const entryNode of entries.items) {
    if (!YAML.isMap(entryNode)) continue;
    const itemsSeq = entryNode.get("items");
    if (!itemsSeq || !YAML.isSeq(itemsSeq)) continue;

    for (const itemNode of itemsSeq.items) {
      if (!YAML.isMap(itemNode)) continue;

      // Never quote attribution entries, only ordinary link items
      if (itemNode.has("quote")) continue;

      const url = itemNode.get("url");
      const title = itemNode.get("title");

      if (typeof url === "string" && (!title || typeof title !== "string" || !title.trim())) {
        targets.push({ url, itemMap: itemNode });
      }
    }
  }

  if (targets.length === 0) {
    console.log("All link items already have titles. Nothing to update.");
    return;
  }

  console.log(`Found ${targets.length} link item(s) missing titles.`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const urlTitleCache = new Map<string, string>();
  let hasFailure = false;
  let updatedCount = 0;

  try {
    const page = await browser.newPage();

    for (const target of targets) {
      try {
        let title = urlTitleCache.get(target.url);
        if (!title) {
          title = await fetchTitle(page, target.url);
          urlTitleCache.set(target.url, title);
        }
        target.itemMap.set("title", title);
        updatedCount++;
        console.log(`Updated "${target.url}" -> "${title}"`);
      } catch (err) {
        console.error(`Failed to fetch title for ${target.url}:`, err);
        hasFailure = true;
      }
    }
  } finally {
    await browser.close();
  }

  if (updatedCount > 0) {
    // Atomic write via temp file
    const tmpPath = `${filePath}.tmp.${Date.now()}`;
    await writeFile(tmpPath, doc.toString(), "utf8");
    await rename(tmpPath, filePath);
    console.log(`Successfully updated ${updatedCount} title(s) in ${filePath}`);
  }

  if (hasFailure) {
    console.error("One or more link titles could not be fetched.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("format-links failed:", err);
  process.exit(1);
});
