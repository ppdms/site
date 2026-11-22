import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-09-04",
        r2Buckets: { DATA: "site-test-data" },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    isolate: true,
  },
});
