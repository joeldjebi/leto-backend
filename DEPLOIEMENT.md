# Déploiement de VITE sur le VPS (Apache)

- **https://leto.performx.online** : back-office (fichiers statiques servis par Apache)
- **https://api.leto.performx.online** : API NestJS + temps réel (Apache → `127.0.0.1:3100`)
- PostgreSQL dans Docker, accessible seulement depuis le serveur (`127.0.0.1:5440`)

Rien n'est modifié sur les autres projets du serveur : base, port, dossier et hôtes virtuels sont propres à VITE.

---

## 0. Vérifications (à lancer d'abord)

```bash
apache2 -v                                   # Apache présent (Ubuntu/Debian)
docker --version && docker compose version   # Docker pour la base
node -v                                      # Node 18 ou plus (sinon étape 2)
sudo ss -ltnp | grep -E ':3100|:5440' || echo "ports 3100 et 5440 libres"
sudo apache2ctl -S 2>/dev/null | grep -i leto || echo "aucun hôte virtuel VITE existant"
```

Si un port est déjà pris, choisissez-en un autre (`PORT` / `DB_PORT` dans `.env`, et le port dans `deploy/apache/api.leto.performx.online.conf`).

## 1. DNS (hPanel Hostinger → Domaines → performx.online → Zone DNS)

Ajouter un enregistrement :

| Type | Nom | Valeur | TTL |
|---|---|---|---|
| A | `api.leto` | `185.215.167.87` | 3600 |

(`leto` pointe déjà vers `185.215.167.87`.) Vérifier après quelques minutes :

```bash
dig +short api.leto.performx.online   # doit afficher 185.215.167.87
```

## 2. Node et pm2 (si absents ou Node < 18)

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 20
npm install -g pm2
```

## 3. Récupérer le code

```bash
sudo mkdir -p /var/www/leto/backoffice
sudo chown -R $USER:$USER /var/www/leto
cd /var/www/leto
git clone https://github.com/joeldjebi/leto-backend.git
git clone https://github.com/joeldjebi/leto-frontend.git
```

## 4. Configuration de l'API

```bash
cd /var/www/leto/leto-backend
cp deploy/.env.production.example .env
echo "DB_PASSWORD : $(openssl rand -hex 24)"
echo "JWT_SECRET  : $(openssl rand -hex 48)"
nano .env    # coller les deux valeurs, choisir SUPER_ADMIN_PASSWORD, ajouter les clés Wasabi
chmod 600 .env
```

## 5. Base de données

```bash
cd /var/www/leto/leto-backend
docker compose --env-file .env -f deploy/docker-compose.prod.yml up -d
docker compose --env-file .env -f deploy/docker-compose.prod.yml ps    # état : running
```

> Vous avez déjà PostgreSQL installé sur le serveur et préférez l'utiliser ? Créez une base dédiée et mettez `DB_PORT=5432` dans `.env` :
> `sudo -u postgres psql -c "CREATE USER leto WITH PASSWORD 'le_mot_de_passe';" -c "CREATE DATABASE leto OWNER leto;"`

## 6. Lancer l'API

```bash
cd /var/www/leto/leto-backend
npm ci
npm run build
pm2 start deploy/ecosystem.config.cjs
pm2 save
pm2 startup          # puis lancer la commande « sudo env PATH=… » qu'il affiche
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3100/auth/me   # 401 = l'API répond
pm2 logs leto-api --lines 20                                              # « VITE API démarrée … »
```

## 7. Back-office

```bash
cd /var/www/leto/leto-frontend
npm ci
npm run build                     # utilise .env.production → https://api.leto.performx.online
rsync -a --delete dist/ /var/www/leto/backoffice/
```

## 8. Apache — serveur cPanel/WHM (cas de ce VPS)

Sur un serveur cPanel, **n'utilisez pas** `a2enmod` / `a2ensite` (cPanel régénère la configuration Apache). Un script fait tout dans le compte cPanel propriétaire du domaine (`performx`) :

```bash
cd /var/www/leto/leto-backend
CPUSER=performx bash deploy/cpanel/setup.sh
```

Il crée les sous-domaines `leto` et `api.leto`, copie le back-office dans `/home/performx/public_html/leto.performx.online`, écrit le relais vers l'API dans `/etc/apache2/conf.d/userdata/{std,ssl}/2_4/performx/api.leto.performx.online/` (conservé par cPanel), redémarre Apache et lance AutoSSL. Les étapes 8 bis et 9 ci-dessous ne concernent alors pas ce serveur.

Mises à jour : `CPUSER=performx bash deploy/update.sh`.

## 8 bis. Apache sans cPanel (Ubuntu/Debian classique)

```bash
sudo a2enmod proxy proxy_http proxy_wstunnel rewrite headers ssl
sudo cp /var/www/leto/leto-backend/deploy/apache/*.conf /etc/apache2/sites-available/
# Si l'étape 0 a montré un hôte virtuel existant pour leto.performx.online : sudo a2dissite <son-fichier>.conf
sudo a2ensite leto.performx.online.conf api.leto.performx.online.conf
sudo apache2ctl configtest        # doit afficher « Syntax OK »
sudo systemctl reload apache2
```

## 9. HTTPS (Let's Encrypt)

```bash
sudo apt install -y certbot python3-certbot-apache    # si certbot est absent
sudo certbot --apache -d leto.performx.online -d api.leto.performx.online --redirect
```

## 10. Vérifier

```bash
curl -s https://api.leto.performx.online/auth/me      # {"message":"Unauthorized","statusCode":401}
curl -sI https://leto.performx.online | head -1        # HTTP/1.1 200 OK
```

Ouvrir **https://leto.performx.online** et se connecter avec `SUPER_ADMIN_PHONE` / `SUPER_ADMIN_PASSWORD`.
Ensuite : créer les entreprises de livraison (Entreprises → Nouvelle entreprise), puis régler les tarifs (Tarifs et règles).

> Comptes de démonstration : `npm run seed` crée des comptes avec des mots de passe simples (`test1234`…). **À éviter en production**, ou à bloquer ensuite depuis le back-office.

---

## Changer le numéro ou le mot de passe du Super Admin

Modifier `SUPER_ADMIN_PHONE` / `SUPER_ADMIN_PASSWORD` dans `.env` (entre guillemets si le mot de passe contient `#` ou des espaces), puis :

```bash
pm2 restart leto-api --update-env
pm2 logs leto-api --lines 50 --nostream | grep "Super Admin"   # « mis à jour depuis le .env »
```

## Mises à jour

```bash
bash /var/www/leto/leto-backend/deploy/update.sh
```

## Applications mobiles

Compiler en pointant vers l'API de production :

```bash
flutter build apk --release --dart-define=API_URL=https://api.leto.performx.online
flutter build ipa --release --dart-define=API_URL=https://api.leto.performx.online
```

## Sauvegarde de la base

```bash
mkdir -p ~/backups
docker exec leto-prod-db-1 pg_dump -U leto leto | gzip > ~/backups/leto-$(date +%F).sql.gz
# Tous les jours à 3 h : crontab -e
# 0 3 * * * docker exec leto-prod-db-1 pg_dump -U leto leto | gzip > ~/backups/leto-$(date +\%F).sql.gz
```

## En cas de problème

| Symptôme | À vérifier |
|---|---|
| 502 / 503 sur l'API | `pm2 status`, `pm2 logs leto-api` |
| Le back-office n'arrive pas à se connecter | `CORS_ORIGIN=https://leto.performx.online` dans `.env`, puis `pm2 reload leto-api --update-env` |
| Pas de temps réel (carte en direct) | `sudo a2enmod proxy_wstunnel` puis recharger Apache |
| Erreur de base au démarrage | `docker compose … ps`, valeurs `DB_*` dans `.env` |
| Photos refusées | Clés Wasabi, ou droits d'écriture sur `leto-backend/uploads/` |
