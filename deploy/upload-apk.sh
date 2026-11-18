#!/usr/bin/env bash
# Met en ligne une nouvelle version de l'app Android (APK) sur la production, sans passer par le back-office.
# À lancer depuis votre Mac (là où se trouve l'APK) :
#   bash deploy/upload-apk.sh /chemin/vers/LETO-1.0.0.apk 1.0.0
# Demande le numéro et le mot de passe du Super Admin (le mot de passe n'est ni affiché ni enregistré).
# Variables facultatives : API (défaut https://api.leto.performx.online), LETO_PHONE (numéro du Super Admin).
set -euo pipefail

APK="${1:-}"
VERSION="${2:-}"
API="${API:-https://api.leto.performx.online}"

[ -n "$APK" ] || { echo "Usage : bash deploy/upload-apk.sh <fichier.apk> <version>"; exit 1; }
[ -f "$APK" ] || { echo "Fichier introuvable : $APK"; exit 1; }
case "$APK" in *.apk|*.APK) ;; *) echo "Fichier APK attendu (.apk)"; exit 1 ;; esac
[ -n "$VERSION" ] || read -r -p "Version (ex. 1.0.0) : " VERSION
SIZE_MB=$(( $(wc -c < "$APK") / 1024 / 1024 ))
[ "$SIZE_MB" -le 200 ] || { echo "Fichier trop lourd ($SIZE_MB Mo, 200 Mo maximum)"; exit 1; }

PHONE="${LETO_PHONE:-}"
[ -n "$PHONE" ] || read -r -p "Numéro du Super Admin : " PHONE
read -r -s -p "Mot de passe : " PASSWORD; echo

# Connexion : le jeton reste en mémoire le temps de l'envoi
LOGIN=$(PHONE="$PHONE" PASSWORD="$PASSWORD" python3 -c 'import json, os; print(json.dumps({"phone": os.environ["PHONE"], "password": os.environ["PASSWORD"]}))' \
  | curl -sS -X POST "$API/auth/login" -H 'Content-Type: application/json' --data-binary @-)
unset PASSWORD
TOKEN=$(printf '%s' "$LOGIN" | python3 -c 'import json, sys
d = json.load(sys.stdin)
print(d.get("token") or "")' 2>/dev/null || true)
if [ -z "$TOKEN" ]; then
  MSG=$(printf '%s' "$LOGIN" | python3 -c 'import json, sys; print(json.load(sys.stdin).get("message", "réponse inattendue"))' 2>/dev/null || echo "réponse inattendue")
  echo "Connexion refusée : $MSG"; exit 1
fi

echo "Envoi de $(basename "$APK") (${SIZE_MB} Mo, version ${VERSION}) vers ${API}…"
OUT=$(mktemp)
CODE=$(curl -sS --progress-bar -o "$OUT" -w '%{http_code}' -X POST "$API/admin/landing/apk" \
  -H "Authorization: Bearer $TOKEN" -F "version=$VERSION" -F "file=@$APK;type=application/vnd.android.package-archive")
unset TOKEN
if [ "$CODE" -ge 200 ] && [ "$CODE" -lt 300 ]; then
  python3 - "$OUT" <<'EOF'
import json, sys
apk = json.load(open(sys.argv[1])).get("apk", {})
print(f"✓ APK en ligne : version {apk.get('version')} · {apk.get('sizeMb')} Mo")
print("  Le bouton « Télécharger l'app » de la landing propose maintenant ce fichier.")
EOF
else
  echo "✗ Envoi refusé (HTTP $CODE) : $(head -c 300 "$OUT")"
  rm -f "$OUT"; exit 1
fi
rm -f "$OUT"
