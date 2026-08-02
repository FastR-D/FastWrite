#!/bin/sh
set -eu

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_ROOT"

bun run build
for browser in chrome firefox webkit; do
  echo "Running FastWrite E2E in $browser"
  FASTWRITE_E2E_BROWSER="$browser" FASTWRITE_E2E_SKIP_BUILD=1 sh scripts/e2e-smoke.sh
done

echo "FastWrite cross-browser checks passed"
