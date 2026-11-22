# Site

Astro static site served by a Cloudflare Worker (`src/worker/index.ts`) that
handles the CV routes and falls through to the static assets.

## Local development

The toolchain uses [Bun](https://bun.com) to install from `bun.lock` and run
scripts. Node.js 26.13.1 must also be on `PATH`: the Cloudflare config loader
used by Astro does not support Bun.

```sh
bun install --frozen-lockfile
bun run dev
bun run check
bun run build
bun run test:media
bun run test:viewer
bun run test:worker
```

`bun run preview:worker` runs `cf dev` (the Astro dev server on workerd,
via the Cloudflare adapter).

## Deployment

Production and preview are separate Workers defined as `cf` modes in
`cloudflare.config.ts`, deployed with the `cf` CLI:

- `bun run deploy` builds and deploys Worker `site` to `papadim.as` and
  `www.papadim.as`.
- `bun run deploy:preview` builds and deploys Worker `site-preview` to
  `preview.papadim.as` only.

Authenticate with `cf auth login`, or set `CLOUDFLARE_API_TOKEN`, which takes
precedence. The deploy scripts and the gallery uploads (`scripts/media.ts`) set
`CLOUDFLARE_AUTH_USE_KEYRING=true` so the project's own `cf` can read a login
stored in the OS keychain.

Both Workers serve the same build and read the same `DATA` R2 bucket; the
Worker only ever reads it. `bun run types` regenerates the binding types in
`.cloudflare/types/`. All Worker configuration lives in `cloudflare.config.ts`;
there is no Wrangler config.

The site uses the `@astrojs/cloudflare` adapter so `cf build` produces Build
Output; a plain static Astro build emits no Build Output for `cf` to deploy.
That currently requires the adapter's beta line
(`@astrojs/cloudflare@15.0.0-beta.6`, with `astro@7.4.13`): the stable
adapter cannot emit `cf` Build Output, which this version writes to
`.cloudflare/output/v1/`. Revisit when the stable adapter catches up.
Because the adapter treats `output: "static"` as assets-only and builds no
Worker, the site uses `output: "server"` with `prerender = true` on every
route; nothing renders on demand.

Gallery ingest scripts (`gallery:add` and `gallery:migrate`) upload media
through `cf r2 objects put`. After publishing a changed gallery manifest, run
`bun run gallery:mosaic` and commit the generated WebP and source list. The
homepage build checks that the sprite matches the manifest; normal builds do
not fetch gallery images.

The gallery loads several screens of thumbnails ahead and prefetches up to two
viewer-sized derivatives for visible photos at low priority, after the visible
thumbnails finish. Speculative loading is disabled on data saver and 2G. The
viewer immediately reuses an available clicked thumbnail, while a preview and
the smallest source suited to the display and zoom level load in parallel.
Images are decoded and crossfaded over the existing image before replacement
(without animation when reduced motion is requested). One preview on either
side is prefetched at low priority; abandoned upgrades are cancelled. The
original remains available via the download link; the location map and its
styles load only when photo details are opened.

The contact sheet uses site-owned layout and viewer code. The location map uses
the OpenFreeMap Dark style and OpenStreetMap/OpenMapTiles data; attribution and
the map-style license are linked from the map.
