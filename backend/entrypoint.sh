#!/bin/sh
set -e

echo "[kspdb] Waiting for Postgres..."
until node -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.\$queryRaw\`SELECT 1\`.then(() => { process.exit(0); }).catch(e => { console.error(e.message); process.exit(1); });
" 2>/dev/null; do
  sleep 2
done

echo "[kspdb] Running Prisma migrations..."
npx prisma migrate deploy

echo "[kspdb] Starting backend server on :${PORT:-3001}..."
exec node dist/index.js
