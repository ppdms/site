import { defineConfig } from "astro/config";
import { build as esbuild } from "esbuild";
import type { Plugin } from "vite";
import { fileURLToPath } from "node:url";

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
        entryPoints: [SHEET_RUNTIME_ENTRY],
        bundle: true,
        write: false,
        format: "iife",
        target: "es2020",
        minify: true,
        legalComments: "none",
        charset: "utf8",
        logLevel: "silent",
      });

      const code = result.outputFiles?.[0]?.text ?? "";
      // Keep the script payload from closing the tag it is inlined into.
      return `export default ${JSON.stringify(code).replaceAll("<", "\\u003c")};`;
    },
  };
}

export default defineConfig({
  site: "https://papadim.as",
  output: "static",
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
  vite: {
    plugins: [inlineGallerySheet()],
  },
});
