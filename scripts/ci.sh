#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if [[ "$(uname -s)" == 'Linux' ]] && [[ ! -x /usr/bin/bwrap && ! -x /bin/bwrap ]]; then
  printf 'Linux CI requires bubblewrap so workspace-sandbox integration tests cannot be skipped.\n' >&2
  exit 1
fi

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
