#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "[security] dependency audit"
audit_file="$(mktemp)"
trap 'rm -f "$audit_file"' EXIT
if ! bun audit --production > "$audit_file"; then
  echo "Dependency audit reported vulnerabilities:" >&2
  cat "$audit_file" >&2
  exit 1
fi

echo "[security] source secret patterns"
bun scripts/check-source-secrets.ts

echo "[security] TypeScript verification"
bun run typecheck

echo "[security] source diff hygiene"
git diff --check

echo "security checks passed"
