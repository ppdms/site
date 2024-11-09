hugo --logLevel info -F --minify --ignoreCache
npx wrangler pages deploy public --project-name site
