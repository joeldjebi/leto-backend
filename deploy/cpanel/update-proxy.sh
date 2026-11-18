#!/usr/bin/env bash
# Réapplique le relais Apache de l'API (deploy/cpanel/leto-proxy.conf.tpl) sans refaire toute l'installation.
#   cd /var/www/leto/leto-backend && CPUSER=performx bash deploy/cpanel/update-proxy.sh
# Écrit uniquement l'inclusion propre à l'hôte api.leto.* (rien dans la configuration globale de WHM).
set -euo pipefail
CPUSER="${CPUSER:-performx}"
ROOTDOMAIN="${ROOTDOMAIN:-performx.online}"
PORT="${PORT:-3100}"
API="api.leto.$ROOTDOMAIN"
HERE="$(cd "$(dirname "$0")" && pwd)"
for type in std ssl; do
  dir="/etc/apache2/conf.d/userdata/$type/2_4/$CPUSER/$API"
  mkdir -p "$dir"
  proto="http"; [ "$type" = ssl ] && proto="https"
  sed -e "s/__PORT__/$PORT/g" -e "s/__PROTO__/$proto/g" "$HERE/leto-proxy.conf.tpl" > "$dir/leto-proxy.conf"
  echo "écrit : $dir/leto-proxy.conf"
done
/scripts/rebuildhttpdconf >/dev/null
apachectl -t
/scripts/restartsrv_httpd >/dev/null && echo "Apache redémarré : envoi de l'APK autorisé jusqu'à 200 Mo"
