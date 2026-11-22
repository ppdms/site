import { defineConfig } from "astro/config";
import { build as esbuild } from "esbuild";
import type { Plugin } from "vite";
import { fileURLToPath } from "node:url";
import cloudflare from "@astrojs/cloudflare";
import type { AstroIntegration } from "astro";
import { keepWords } from "./scripts/keep-words";

const SHEET_RUNTIME_ID = "virtual:gallery-sheet";
const SHEET_RUNTIME_ENTRY = fileURLToPath(
  new URL("./src/scripts/gallery-sheet.ts", import.meta.url)
);

/**
 * The contact sheet is arranged per visit, and that arrangement has to be in
 * place before the first paint or the cells visibly jump. A deferred module
 * script cannot promise that, so the sheet runtime is bundled into a classic
 * script the page can inline — built from the same sources as the rest of the
 * gallery rather than duplicated by hand.
 */
function inlineGallerySheet(): Plugin {
  const resolvedId = `\0${SHEET_RUNTIME_ID}`;

  return {
    name: "gallery-sheet-inline",
    resolveId(id) {
      return id === SHEET_RUNTIME_ID ? resolvedId : undefined;
    },
    async load(id) {
      if (id !== resolvedId) return undefined;

      const result = await esbuild({
        absWorkingDir: fileURLToPath(new URL(".", import.meta.url)),
        entryPoints: [SHEET_RUNTIME_ENTRY],
        bundle: true,
        write: false,
        metafile: true,
        format: "iife",
        target: "es2020",
        minify: true,
        legalComments: "none",
        charset: "utf8",
        logLevel: "silent",
      });

      // The inline bundle must be invalidated when its layout dependencies change.
      for (const input of Object.keys(result.metafile.inputs)) {
        this.addWatchFile(fileURLToPath(new URL(input, import.meta.url)));
      }

      const code = result.outputFiles?.[0]?.text ?? "";
      // Keep the script payload from closing the tag it is inlined into.
      return `export default ${JSON.stringify(code).replaceAll("<", "\\u003c")};`;
    },
  };
}

/** Keeps hyphenated words whole in every built page (scripts/keep-words.ts). */
function keepWordsWhole(): AstroIntegration {
  return {
    name: "keep-words",
    hooks: {
      "astro:build:done": async ({ dir, logger }) => {
        const { pages, words } = await keepWords(fileURLToPath(dir));
        if (!pages) throw new Error(`keep-words: no pages found in ${fileURLToPath(dir)}`);
        logger.info(`kept ${words} hyphenated words whole across ${pages} pages`);
      },
    },
  };
}

export default defineConfig({
  site: "https://papadim.as",
  // "server" so the Cloudflare adapter builds the Worker entrypoint; every
  // route sets `prerender = true`, so the deployed site is fully static and
  // nothing is rendered on demand.
  output: "server",
  // No page uses Astro sessions; do not provision the adapter's SESSION KV.
  session: false,
  // Build-time image transforms (Sharp), as before the adapter: the default
  // Cloudflare binding service would emit the raw multi-megabyte originals
  // as assets. No page is server-rendered, so no runtime image service runs.
  adapter: cloudflare({
    imageService: { build: "compile", runtime: "passthrough" },
    // Prerender in Node so Sharp image transforms run exactly as they did
    // before the adapter; workerd prerendering cannot run Sharp and would
    // emit the raw originals as assets instead.
    prerenderEnvironment: "node",
  }),
  outDir: "./dist",
  publicDir: "./static",
  trailingSlash: "always",
  build: {
    format: "directory",
  },
  markdown: {
    shikiConfig: {
      themes: {
        light: "github-light",
        dark: "github-dark",
      },
      wrap: true,
    },
  },
  integrations: [keepWordsWhole()],
  vite: {
    plugins: [inlineGallerySheet()],
  },
});
