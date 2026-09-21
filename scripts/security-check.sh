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

echo "[security] tracked secret patterns"
if git grep -n -I -E '(OPENAI_API_KEY|FASTWRITE_.*SECRET|AWS_SECRET_ACCESS_KEY)[[:space:]]*=[[:space:]]*[A-Za-z0-9_./+=-]{8,}|-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY-----' -- ':!docs' ':!scripts/security-check.sh' ':!*.test.ts' | grep -v -E 'process\.env|\.env\.example|placeholder|example|YOUR_|\.\.\.' ; then
  echo "Potential tracked secret detected" >&2
  exit 1
fi

echo "[security] TypeScript verification"
bun run typecheck

echo "[security] source diff hygiene"
git diff --check

echo "security checks passed"
