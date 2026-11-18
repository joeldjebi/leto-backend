#!/usr/bin/env bash
# Déplace le back-office de leto.performx.online vers sa.leto.performx.online (à lancer en root) :
#   bash deploy/cpanel/move-backoffice.sh
# leto.performx.online accueille ensuite la landing page (qui renvoie les anciens liens #/… vers le back-office).
set -euo pipefail

CPUSER="${CPUSER:-performx}"
ROOTDOMAIN="${ROOTDOMAIN:-performx.online}"
SUB="${SUB:-sa.leto}"
SERVER_IP="${SERVER_IP:-185.215.167.87}"
FRONT_DIST="${FRONT_DIST:-/var/www/leto/leto-frontend/dist}"
HOME_DIR="$(getent passwd "$CPUSER" | cut -d: -f6)"
[ -n "$HOME_DIR" ] || { echo "Compte cPanel « $CPUSER » introuvable"; exit 1; }
NEW_DIR="$HOME_DIR/public_html/$SUB.$ROOTDOMAIN"

echo "== 1. Sous-domaine $SUB.$ROOTDOMAIN (compte $CPUSER)"
if [ -n "$(/scripts/whoowns "$SUB.$ROOTDOMAIN" 2>/dev/null)" ]; then
  echo "existe déjà"
else
  uapi --user="$CPUSER" SubDomain addsubdomain domain="$SUB" rootdomain="$ROOTDOMAIN" dir="public_html/$SUB.$ROOTDOMAIN" | grep -E "status:|errors:|- " || true
fi
ip="$(dig +short "$SUB.$ROOTDOMAIN" A | tail -1)"
if [ "$ip" = "$SERVER_IP" ]; then echo "DNS $SUB.$ROOTDOMAIN → $ip ✓"; else echo "⚠ DNS $SUB.$ROOTDOMAIN → « ${ip:-aucun} » (attendu $SERVER_IP) : ajoutez l'enregistrement A, puis relancez ce script"; fi

echo "== 2. Back-office → $NEW_DIR"
cd /var/www/leto/leto-frontend && npm run build >/dev/null
mkdir -p "$NEW_DIR"
rsync -a --delete --exclude ".well-known" "$FRONT_DIST/" "$NEW_DIR/"
chown -R "$CPUSER:$CPUSER" "$NEW_DIR"

echo "== 3. Certificat HTTPS (AutoSSL du compte)"
/usr/local/cpanel/bin/autossl_check --user="$CPUSER" || echo "⚠ AutoSSL : relancez plus tard (WHM → Manage AutoSSL)"

if [ "$ip" = "$SERVER_IP" ] && curl -fsS -o /dev/null --max-time 15 "https://$SUB.$ROOTDOMAIN/"; then
  echo "✓ Back-office disponible sur https://$SUB.$ROOTDOMAIN"
else
  echo "⚠ Back-office copié, mais https://$SUB.$ROOTDOMAIN n'est pas encore joignable (DNS ou certificat) : relancez ce script une fois le DNS en place"
fi
