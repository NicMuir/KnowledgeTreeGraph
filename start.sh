#!/bin/sh
# Headless start: Postgres + migrations + API in the foreground.
# For the interactive console use `kb serve` instead.
set -e
cd "$(dirname "$0")"

set -a; . ./.env; set +a             # prisma CLI needs DATABASE_URL in the environment
docker compose up -d --wait          # --wait blocks until the pg healthcheck passes
pnpm --filter @kb/db migrate
exec pnpm --filter @kb/api dev
