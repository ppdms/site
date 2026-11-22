/*
 * Words are never divided across lines on this site. Justified paragraphs
 * are broken by src/scripts/justify.ts, which never splits a word; elsewhere
 * a browser may still end a line after the hyphen of a compound
 * ("content-/addressable", "end-to-/end"). At the end of every `astro build`
 * (an integration in astro.config.ts, so `cf deploy`'s own build runs it
 * too) this wraps every hyphenated word in the built pages in
 * <span class="nb">, which global.css sets to `white-space: nowrap`, so the
 * word moves to the next line whole instead.
 *
 * Only the markup changes: the text keeps its own hyphens and gains no
 * invisible characters, so copying and find-in-page are unaffected. Code,
 * scripts, styles, the document head and attributes are left alone.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fromHtml } from "hast-util-from-html";
import { toHtml } from "hast-util-to-html";
import type { Element, Nodes, Parents, Text } from "hast";

const SKIP = new Set(["head", "script", "style", "pre", "code", "kbd", "samp", "textarea", "svg", "math", "template", "title"]);
// A word with at least one hyphen between letters or digits: "self-hosted",
// "Tweet-to-Wikipedia-article", "10-15".
const COMPOUND = /[\p{L}\p{N}]+(?:[-‐][\p{L}\p{N}]+)+/gu;

function classes(node: Element): string[] {
  const value = node.properties?.className;
  return Array.isArray(value) ? value.map(String) : [];
}

function keepWhole(text: Text): Nodes[] | null {
  const parts: Nodes[] = [];
  let last = 0;
  for (const match of text.value.matchAll(COMPOUND)) {
    const at = match.index!;
    if (at > last) parts.push({ type: "text", value: text.value.slice(last, at) });
    parts.push({
      type: "element",
      tagName: "span",
      properties: { className: ["nb"] },
      children: [{ type: "text", value: match[0] }],
    });
    last = at + match[0].length;
  }
  if (!parts.length) return null;
  if (last < text.value.length) parts.push({ type: "text", value: text.value.slice(last) });
  return parts;
}

function walk(parent: Parents): number {
  let wrapped = 0;
  const children: Nodes[] = [];
  for (const child of parent.children as Nodes[]) {
    if (child.type === "text") {
      const parts = keepWhole(child);
      if (parts) {
        children.push(...parts);
        wrapped += parts.filter((part) => part.type === "element").length;
        continue;
      }
    } else if (child.type === "element") {
      const skip = SKIP.has(child.tagName) || classes(child).some((name) => name === "nb" || name === "phrase");
      if (!skip) wrapped += walk(child);
    }
    children.push(child);
  }
  (parent as { children: Nodes[] }).children = children;
  return wrapped;
}

async function htmlFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await htmlFiles(path)));
    else if (entry.name.endsWith(".html")) files.push(path);
  }
  return files;
}

/** Processes every page under `root`; returns the pages and words seen. */
export async function keepWords(root: string): Promise<{ pages: number; words: number }> {
  let words = 0;
  const files = await htmlFiles(root);
  for (const file of files) {
    const tree = fromHtml(await readFile(file, "utf8"));
    const wrapped = walk(tree);
    if (!wrapped) continue;
    await writeFile(file, toHtml(tree));
    words += wrapped;
  }
  return { pages: files.length, words };
}
