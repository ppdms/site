#!/usr/bin/env bash
set -euo pipefail

if ! node -e 'require.resolve("puppeteer")' >/dev/null 2>&1; then
    npm install --no-save --no-package-lock puppeteer
fi

node format-links.js "$@"