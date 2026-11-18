#!/usr/bin/env bash
# Mise à jour de LETO en production (API + back-office) : bash deploy/update.sh
set -euo pipefail
ROOT=/var/www/leto
# Dossier web du back-office (cPanel : /home/performx/public_html/sa.leto.performx.online)
BACKOFFICE_DIR="${BACKOFFICE_DIR:-/home/performx/public_html/sa.leto.performx.online}"
CPUSER="${CPUSER:-performx}"

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
rsync -a --delete --exclude ".well-known" dist/ "$BACKOFFICE_DIR/"
chown -R "$CPUSER:$CPUSER" "$BACKOFFICE_DIR"

echo "Mise à jour terminée."
