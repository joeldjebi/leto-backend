#!/usr/bin/env bash
# Mise à jour de VITE en production (API + back-office) : bash deploy/update.sh
set -euo pipefail
ROOT=/var/www/leto
# Dossier web du back-office (cPanel : /home/performx/public_html/sa.leto.performx.online)
BACKOFFICE_DIR="${BACKOFFICE_DIR:-/home/performx/public_html/sa.leto.performx.online}"
CPUSER="${CPUSER:-performx}"
# Espace entreprise sur le domaine principal : leto.performx.online/pro (même back-office)
PRO_DIR="${PRO_DIR:-/home/performx/public_html/leto.performx.online/pro}"

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
if [ -n "$PRO_DIR" ]; then
  mkdir -p "$PRO_DIR"
  rsync -a --delete dist/ "$PRO_DIR/"
  chown -R "$CPUSER:$CPUSER" "$PRO_DIR"
  echo "Espace entreprise : $PRO_DIR"
fi

echo "Mise à jour terminée."
