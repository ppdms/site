const fs = require('fs').promises;
const puppeteer = require('puppeteer');
const path = require('path');

async function fetchTitle(url) {
  const browser = await puppeteer.launch();
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    await page.goto(url, {
      waitUntil: 'networkidle0',
      timeout: 10000
    });

    const title = await page.title();
    return title.trim();
  } catch (error) {
    console.error(`Error fetching title for ${url}:`, error.message);
    return null;
  } finally {
    await browser.close();
  }
}

async function processFile(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.split('\n');
    const newLines = [];

    for (const line of lines) {
      const urlRegex = /https?:\/\/\S+/;
      const markdownLinkRegex = /\[([^\]]+)\]\(https?:\/\/\S+\)/;

      if (line.match(urlRegex) && !line.match(markdownLinkRegex)) {
        const url = line.match(urlRegex)[0];
        console.log(`Fetching title for ${url}`);
        const title = await fetchTitle(url);

        if (title) {
          const bulletMatch = line.match(/^(\s*-\s*)?/);
          const bullet = bulletMatch ? bulletMatch[0] : '';
          newLines.push(`${bullet}[${title}](${url})`);
        } else {
          newLines.push(line);
        }
      } else {
        newLines.push(line);
      }
    }

    await fs.writeFile(filePath, newLines.join('\n'));
    console.log('File processing complete!');
  } catch (error) {
    console.error('Error processing file:', error);
  }
}

const filePath = path.join(__dirname, 'content', 'posts', 'links.md');
processFile(filePath);