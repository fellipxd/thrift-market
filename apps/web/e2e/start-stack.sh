#!/usr/bin/env bash
# Reseeds the E2E database, then runs the worker (background) and the web app (foreground).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
export DATABASE_URL="${E2E_DATABASE_URL:-postgres://thrift:thrift@localhost:5432/thrift_e2e}"
export MEDIA_STORAGE_DIR=".data/e2e-media"
export APP_BASE_URL="http://localhost:${E2E_PORT:-3200}"
export WORKER_TICK_MS=1000
(cd "$ROOT" && pnpm --filter @thrift/application seed --reset >/dev/null)
(cd "$ROOT" && pnpm --filter @thrift/worker start >/tmp/thrift-e2e-worker.log 2>&1) &
WORKER_PID=$!
trap 'kill $WORKER_PID 2>/dev/null || true' EXIT
cd "$ROOT/apps/web" && npx next dev -p "${E2E_PORT:-3200}"
