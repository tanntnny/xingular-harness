#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

run_check() {
  local description="$1"
  shift
  printf '\n==> %s\n' "$description"
  "$@"
}

run_check 'TypeScript typecheck' npm run typecheck
run_check 'Unit and golden tests' npm test
run_check 'Standalone harness proof' npm run prove

printf '\nAll CI checks passed.\n'
