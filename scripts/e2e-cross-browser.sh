#!/bin/sh
set -eu

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_ROOT"

bun run build
for browser in chrome firefox webkit; do
  echo "Running FastWrite E2E in $browser"
  FASTWRITE_E2E_BROWSER="$browser" node scripts/e2e-smoke.mjs
done

echo "FastWrite cross-browser checks passed"
