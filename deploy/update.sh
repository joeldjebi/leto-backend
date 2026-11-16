#!/usr/bin/env bash
# Mise à jour de LETO en production (API + back-office) : bash deploy/update.sh
set -euo pipefail
ROOT=/var/www/leto

echo "== API"
cd "$ROOT/leto-backend"
git pull --ff-only
npm ci
npm run build
pm2 reload leto-api --update-env

echo "== Back-office"
cd "$ROOT/leto-frontend"
git pull --ff-only
npm ci
npm run build
rsync -a --delete dist/ "$ROOT/backoffice/"

echo "Mise à jour terminée."
