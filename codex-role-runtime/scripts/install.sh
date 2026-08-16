#!/usr/bin/env sh
set -eu
plugin_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$plugin_root"
npm ci
npm test
node ./scripts/install-local.mjs
