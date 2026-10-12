#!/usr/bin/env bash
# Bootstraps a local Postgres 16 + PostGIS on Debian/Ubuntu (used in cloud dev containers).
# Alternative: `docker compose up -d postgres`.
set -euo pipefail
if ! dpkg -s postgresql-16-postgis-3 >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql-16 postgresql-16-postgis-3
fi
sudo pg_ctlcluster 16 main start || true
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='thrift'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE ROLE thrift WITH LOGIN SUPERUSER PASSWORD 'thrift';"
for db in thrift_dev thrift_test; do
  sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1 || \
    sudo -u postgres psql -c "CREATE DATABASE $db OWNER thrift;"
done
[ -f .env ] || cp .env.example .env
pnpm install
pnpm db:migrate
echo "Ready. Run: pnpm db:seed && pnpm dev (web) and pnpm dev:worker (worker)."
