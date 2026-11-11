#!/bin/sh
set -eu

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_ROOT"

bun run typecheck
bun run build
bun run test
bun run writing:eval
bun run security:check
bun run e2e:smoke

echo "FastWrite CI checks passed"
