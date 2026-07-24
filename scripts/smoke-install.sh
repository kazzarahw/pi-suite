#!/usr/bin/env bash
#
# Install smoke test — the guard for the bug that made this consolidation necessary.
#
# Pi installs packages with `npm install --omit=dev` (documented in its extensions.md),
# so anything imported at runtime from `devDependencies` is ABSENT on a real install.
# The pre-consolidation suite imported runtime values (MODES, injectionBlock, …) from a
# `pi-shared` devDependency, which meant every `pi install git:...` produced extensions
# that failed to load with "Cannot find package 'pi-shared'".
#
# This reproduces a real install exactly — clean clone, production-only deps — and then
# asserts all seven extensions load and register their tools.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> cloning $REPO_ROOT at HEAD"
git clone --quiet --no-local "$REPO_ROOT" "$WORK/pi-suite"
cd "$WORK/pi-suite"

echo "==> npm install --omit=dev  (exactly what pi does)"
npm install --omit=dev --no-audit --no-fund --silent

echo "==> asserting no devDependency is reachable"
if [ -d node_modules/pi-shared ]; then
  echo "FAIL: pi-shared resolved as a package — shared/ must be an internal module." >&2
  exit 1
fi

echo "==> loading all seven extensions"
# MUST run the CLONE's copy, from inside the clone. Running $REPO_ROOT's copy would
# resolve its relative imports against the full dev tree — the clone would never be
# exercised and the test would pass unconditionally. (It did, until this was fixed.)
bun run ./scripts/smoke-load.ts

echo "==> smoke install PASSED"
