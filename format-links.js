const fs = require("node:fs/promises");
const path = require("node:path");

const itemHeaderPattern = /^\s*\[\[entries\.items\]\]\s*$/;
const entryHeaderPattern = /^\s*\[\[entries(?:\.items)?\]\]\s*$/;
const titlePattern = /^\s*title\s*=/;
const urlPattern = /^(\s*)url\s*=\s*("(?:\\.|[^"\\])*")\s*$/;

function findUntitledItems(lines) {
  const items = [];

  for (let start = 0; start < lines.length; start += 1) {
    if (!itemHeaderPattern.test(lines[start])) {
      continue;
    }

    let end = start + 1;
    while (end < lines.length && !entryHeaderPattern.test(lines[end])) {
      end += 1;
    }

    const itemLines = lines.slice(start + 1, end);
    if (itemLines.some((line) => titlePattern.test(line))) {
      continue;
    }

    const relativeUrlIndex = itemLines.findIndex((line) =>
      urlPattern.test(line),
    );
    if (relativeUrlIndex === -1) {
      continue;
    }

    const lineIndex = start + 1 + relativeUrlIndex;
    const match = lines[lineIndex].match(urlPattern);
    items.push({
      lineIndex,
      indent: match[1],
      url: JSON.parse(match[2]),
    });
  }

  return items;
}

async function fetchTitle(page, url) {
  console.log(`Fetching title for ${url}`);
  await page.goto(url, {
    waitUntil: "networkidle2",
    timeout: 30_000,
  });

  const title = (await page.title()).trim();
  if (!title) {
    throw new Error("The page returned an empty title");
  }

  return title;
}

async function processFile(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  const lines = content.split("\n");
  const items = findUntitledItems(lines);

  if (items.length === 0) {
    console.log("No backlink items are missing titles.");
    return;
  }

  let puppeteer;
  try {
    puppeteer = require("puppeteer");
  } catch {
    throw new Error("Puppeteer is required; run ./convert_links.sh instead.");
  }

  const browser = await puppeteer.launch();
  const insertions = new Map();
  let failed = false;

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/126.0.0.0 Safari/537.36",
    );

    const titles = new Map();
    for (const item of items) {
      try {
        let title = titles.get(item.url);
        if (title === undefined) {
          title = await fetchTitle(page, item.url);
          titles.set(item.url, title);
        }
        insertions.set(
          item.lineIndex,
          `${item.indent}title = ${JSON.stringify(title)}`,
        );
      } catch (error) {
        failed = true;
        console.error(`Could not fetch ${item.url}: ${error.message}`);
      }
    }
  } finally {
    await browser.close();
  }

  if (insertions.size > 0) {
    const updatedLines = [];
    for (let index = 0; index < lines.length; index += 1) {
      const titleLine = insertions.get(index);
      if (titleLine !== undefined) {
        updatedLines.push(titleLine);
      }
      updatedLines.push(lines[index]);
    }
    await fs.writeFile(filePath, updatedLines.join("\n"));
    console.log(`Added ${insertions.size} title(s) to ${filePath}.`);
  }

  if (failed) {
    process.exitCode = 1;
  }
}

const filePath = path.resolve(
  process.argv[2] || path.join(__dirname, "content", "backlinks.md"),
);

processFile(filePath).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
