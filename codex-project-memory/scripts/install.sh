#!/usr/bin/env sh
set -eu
PLUGIN_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
node "$PLUGIN_DIR/scripts/install-local.mjs"
