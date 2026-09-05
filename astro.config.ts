import { defineConfig } from "astro/config";

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
});
