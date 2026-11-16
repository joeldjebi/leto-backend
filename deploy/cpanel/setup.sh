#!/usr/bin/env bash
# Mise en ligne de LETO sur un serveur cPanel/WHM (à lancer en root) :
#   CPUSER=performx bash deploy/cpanel/setup.sh
# Crée leto.performx.online (back-office) et api.leto.performx.online (API) dans le compte cPanel,
# configure le relais Apache vers l'API et demande les certificats HTTPS (AutoSSL).
set -euo pipefail

CPUSER="${CPUSER:-performx}"
ROOTDOMAIN="${ROOTDOMAIN:-performx.online}"
PORT="${PORT:-3100}"
SERVER_IP="${SERVER_IP:-185.215.167.87}"
HERE="$(cd "$(dirname "$0")" && pwd)"
FRONT_DIST="${FRONT_DIST:-/var/www/leto/leto-frontend/dist}"

BO="leto.$ROOTDOMAIN"
API="api.leto.$ROOTDOMAIN"
HOME_DIR="$(getent passwd "$CPUSER" | cut -d: -f6)"
[ -n "$HOME_DIR" ] || { echo "Compte cPanel « $CPUSER » introuvable"; exit 1; }
BO_DIR="$HOME_DIR/public_html/$BO"
API_DIR="$HOME_DIR/public_html/$API"

echo "== 0. Vérifications"
[ -f "$FRONT_DIST/index.html" ] || { echo "Back-office non compilé : cd /var/www/leto/leto-frontend && npm run build"; exit 1; }
curl -s -o /dev/null -w "API locale : %{http_code} (401 attendu)\n" "http://127.0.0.1:$PORT/auth/me" || true
for d in "$BO" "$API"; do
  ip="$(dig +short "$d" A | tail -1)"
  if [ "$ip" = "$SERVER_IP" ]; then echo "DNS $d → $ip ✓"; else echo "⚠ DNS $d → « ${ip:-aucun} » (attendu $SERVER_IP) : AutoSSL échouera tant que ce n'est pas corrigé"; fi
done

echo "== 1. Sous-domaines dans le compte $CPUSER"
for sub in leto api.leto; do
  if /scripts/whoowns "$sub.$ROOTDOMAIN" >/dev/null 2>&1 && [ -n "$(/scripts/whoowns "$sub.$ROOTDOMAIN")" ]; then
    echo "$sub.$ROOTDOMAIN existe déjà"
  else
    uapi --user="$CPUSER" SubDomain addsubdomain domain="$sub" rootdomain="$ROOTDOMAIN" dir="public_html/$sub.$ROOTDOMAIN" \
      | grep -E "status:|errors:|- " || true
  fi
done

echo "== 2. Back-office → $BO_DIR"
mkdir -p "$BO_DIR"
rsync -a --delete --exclude ".well-known" "$FRONT_DIST/" "$BO_DIR/"
chown -R "$CPUSER:$CPUSER" "$BO_DIR"
mkdir -p "$API_DIR" && chown "$CPUSER:$CPUSER" "$API_DIR"

echo "== 3. Relais Apache vers l'API (port $PORT)"
for type in std ssl; do
  dir="/etc/apache2/conf.d/userdata/$type/2_4/$CPUSER/$API"
  mkdir -p "$dir"
  proto="http"; [ "$type" = ssl ] && proto="https"
  sed -e "s/__PORT__/$PORT/g" -e "s/__PROTO__/$proto/g" "$HERE/leto-proxy.conf.tpl" > "$dir/leto-proxy.conf"
  echo "écrit : $dir/leto-proxy.conf"
done
/scripts/rebuildhttpdconf >/dev/null
apachectl -t
/scripts/restartsrv_httpd >/dev/null && echo "Apache redémarré"

echo "== 4. Certificats HTTPS (AutoSSL)"
/usr/local/cpanel/bin/autossl_check --user="$CPUSER" || echo "⚠ AutoSSL : relancez plus tard (WHM → Manage AutoSSL)"
/scripts/rebuildhttpdconf >/dev/null && /scripts/restartsrv_httpd >/dev/null

echo "== 5. Vérification"
curl -s -o /dev/null -w "https://$API/auth/me → %{http_code} (401 attendu)\n" "https://$API/auth/me" || true
curl -s -o /dev/null -w "https://$BO → %{http_code} (200 attendu)\n" "https://$BO/" || true
echo "Terminé. Ouvrez https://$BO"
