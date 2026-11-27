#!/usr/bin/env bash
# Passage aux domaines vite.ci (à lancer en root, une fois les domaines créés dans cPanel) :
#   cd /var/www/leto/leto-backend && bash deploy/cpanel/setup-vite-ci.sh
#
#   VITE           vite.ci (landing) · vite.ci/pro (entreprises) · leto.vite.ci (admin) · api.vite.ci (API, port 3100)
#   Adjamé-Smart   as.vite.ci (vitrine) · boutique.vite.ci · sa.vite.ci (admin) · api.as.vite.ci (API, port 3200)
#
# Écrit seulement les inclusions propres aux hôtes api.* (rien dans la configuration globale de WHM),
# vérifie les DNS et demande les certificats HTTPS (AutoSSL).
# Les anciennes adresses : REDIRECT_OLD=1 bash deploy/cpanel/setup-vite-ci.sh (à faire quand vite.ci répond).
# api.leto.performx.online reste en service pour les applications déjà installées.
set -euo pipefail

CPUSER="${CPUSER:-performx}"
SERVER_IP="${SERVER_IP:-185.215.167.87}"
HERE="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="$(getent passwd "$CPUSER" | cut -d: -f6)"
[ -n "$HOME_DIR" ] || { echo "Compte cPanel « $CPUSER » introuvable"; exit 1; }

DOMAINS="vite.ci www.vite.ci leto.vite.ci api.vite.ci as.vite.ci api.as.vite.ci boutique.vite.ci sa.vite.ci"

echo "== 1. DNS (doivent pointer vers $SERVER_IP)"
for d in $DOMAINS; do
  ip="$(dig +short "$d" A | tail -1)"
  if [ "$ip" = "$SERVER_IP" ]; then echo "  ✓ $d"; else echo "  ⚠ $d → « ${ip:-aucun} » : à corriger dans MTN Cloud (le certificat HTTPS échouera)"; fi
done

echo "== 2. Domaines présents dans le compte $CPUSER"
missing=0
for d in vite.ci leto.vite.ci api.vite.ci as.vite.ci api.as.vite.ci boutique.vite.ci sa.vite.ci; do
  if [ -n "$(/scripts/whoowns "$d" 2>/dev/null)" ]; then echo "  ✓ $d"; else echo "  ✗ $d : à créer dans cPanel › Domaines"; missing=1; fi
done
[ "$missing" = 0 ] || { echo "Créez d'abord les domaines manquants dans cPanel, puis relancez ce script."; exit 1; }

echo "== 3. Relais Apache vers les API"
proxy() { # $1 = hôte, $2 = port
  for type in std ssl; do
    dir="/etc/apache2/conf.d/userdata/$type/2_4/$CPUSER/$1"
    mkdir -p "$dir"
    proto="http"; [ "$type" = ssl ] && proto="https"
    sed -e "s/__PORT__/$2/g" -e "s/__PROTO__/$proto/g" "$HERE/leto-proxy.conf.tpl" > "$dir/leto-proxy.conf"
  done
  echo "  ✓ $1 → 127.0.0.1:$2"
}
proxy api.vite.ci 3100
proxy api.as.vite.ci 3200
for d in leto.vite.ci as.vite.ci boutique.vite.ci sa.vite.ci api.vite.ci api.as.vite.ci; do
  mkdir -p "$HOME_DIR/public_html/$d" && chown "$CPUSER:$CPUSER" "$HOME_DIR/public_html/$d"
done
mkdir -p "$HOME_DIR/public_html/vite.ci/pro" && chown -R "$CPUSER:$CPUSER" "$HOME_DIR/public_html/vite.ci"

if [ "${REDIRECT_OLD:-0}" = 1 ]; then
  echo "== 4. Anciennes adresses → nouvelles (redirection permanente)"
  redirect() { # $1 = ancien hôte, $2 = nouvelle adresse
    dir="$HOME_DIR/public_html/$1"
    [ -d "$dir" ] || { echo "  - $1 : dossier absent, ignoré"; return; }
    [ -f "$dir/.htaccess" ] && cp "$dir/.htaccess" "$dir/.htaccess.avant-vite-ci"
    printf 'RewriteEngine On\nRewriteCond %%{REQUEST_URI} !^/\\.well-known/\nRewriteRule ^(.*)$ %s/$1 [R=301,L]\n' "$2" > "$dir/.htaccess"
    chown "$CPUSER:$CPUSER" "$dir/.htaccess"
    echo "  ✓ $1 → $2"
  }
  redirect leto.performx.online https://vite.ci
  redirect sa.leto.performx.online https://leto.vite.ci
  echo "  api.leto.performx.online reste actif (applications déjà installées)"
fi

/scripts/rebuildhttpdconf >/dev/null
apachectl -t
/scripts/restartsrv_httpd >/dev/null && echo "== Apache redémarré"

echo "== 5. Certificats HTTPS (AutoSSL)"
/usr/local/cpanel/bin/autossl_check --user="$CPUSER" || echo "⚠ AutoSSL : relancez plus tard (WHM › Manage AutoSSL)"
/scripts/rebuildhttpdconf >/dev/null && /scripts/restartsrv_httpd >/dev/null
echo "Terminé."
