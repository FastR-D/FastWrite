#!/bin/sh
set -eu

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_ROOT"

bun run typecheck
# API tests exercise SPA routes served from the built web client.
bun run build
bun run test
bun run writing:eval
FASTWRITE_E2E_SKIP_BUILD=1 bun run e2e:smoke

echo "FastWrite release checks passed"
