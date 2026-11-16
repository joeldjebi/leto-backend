# LETO — Backend (API)

API NestJS + PostgreSQL de la plateforme de livraison LETO (Abidjan, Côte d'Ivoire).

- **Clients** (particuliers, boutiques) créent des demandes de livraison.
- **Livreurs** des entreprises de livraison acceptent et effectuent les courses.
- **Entreprises** gèrent leurs livreurs et suivent leurs courses.
- **Super Admin (SA)** gère les entreprises partenaires.

## Démarrer

```bash
docker compose up -d        # PostgreSQL sur le port 5440
cp .env.example .env
npm install
npm run start:dev           # http://localhost:3000
```

Un compte Super Admin (SA) est créé au premier démarrage (`SUPER_ADMIN_PHONE` / `SUPER_ADMIN_PASSWORD` dans `.env`).

## Parcours d'une livraison

`PENDING` (en attente) → `ACCEPTED` (un livreur accepte) → `PICKED_UP` (colis récupéré) → `DELIVERED` (le livreur saisit le code à 4 chiffres donné par le destinataire). Le client peut annuler tant que la course est `PENDING`.

L'acceptation est atomique : si deux livreurs acceptent en même temps, un seul obtient la course.

## Tarifs (`src/pricing/pricing.ts`)

Prix = max(minimum, base + prix/km × distance) × facteur délai (+ 250 F si paiement à la livraison), arrondi aux 50 F supérieurs. La distance est celle de l'itinéraire réel, et le prix est toujours recalculé par le serveur.

| Offre | Base | /km | Minimum |
|---|---|---|---|
| Moto | 500 F | 150 F | 1 000 F |
| Voiture | 1 000 F | 250 F | 2 000 F |
| Cargo | 3 000 F | 400 F | 5 000 F |

Délai : Express ×1,2 · Standard ×1 · Dans 2 heures ×0,85.

## Paiement à la livraison

Le client indique le montant de la marchandise (`codAmount`). Le livreur l'encaisse pour son **entreprise**, qui le reverse ensuite au client et le marque « reversé » (`POST /deliveries/:id/cod-remitted`).

Le mode de paiement de la course (`CASH`, `WAVE`, `ORANGE_MONEY`, `MTN_MOMO`) est déclaratif : le client paie le livreur directement. Il n'y a pas encore d'intégration d'API Mobile Money.

## Cartographie (OpenStreetMap + Google)

- Les apps affichent les tuiles OpenStreetMap.
- Les recherches passent par `/geo/*` : Google (si `GOOGLE_MAPS_API_KEY` est renseignée dans `.env`) et OpenStreetMap, fusionnés.
- L'itinéraire vient de Google Routes, sinon d'OSRM, sinon d'une estimation à vol d'oiseau.
- Sans clé, tout fonctionne avec OpenStreetMap uniquement.
- Nominatim et OSRM publics conviennent au développement (environ 1 requête/s). En production, il faut une clé Google ou des serveurs auto-hébergés.

## Endpoints

| Méthode | Route | Rôle |
|---|---|---|
| POST | `/auth/register` | public (crée un client) |
| POST | `/auth/login` | public |
| GET | `/auth/me` | connecté |
| GET | `/geo/search?q=&lat=&lng=`, `/geo/reverse?lat=&lng=`, `/geo/route?fromLat=…` | connecté |
| POST | `/pricing/quote` · GET `/pricing/eta?lat=&lng=` · GET `/pricing/grid` | connecté |
| POST | `/uploads` (photo d'adresse, multipart `file`) | connecté |
| POST | `/deliveries` | CLIENT |
| GET | `/deliveries/mine`, `/deliveries/mine/:id` | CLIENT |
| POST | `/deliveries/:id/cancel` | CLIENT |
| GET | `/deliveries/available`, `/deliveries/driver` | DRIVER |
| POST | `/deliveries/:id/accept`, `/pickup`, `/deliver` | DRIVER |
| GET | `/deliveries/company` | COMPANY |
| POST | `/deliveries/:id/cod-remitted` | COMPANY |
| GET/POST | `/companies/me/drivers` | COMPANY |
| PATCH | `/companies/me/drivers/:id/active?value=` | COMPANY |
| GET | `/deliveries` | SUPER_ADMIN |
| GET/POST | `/companies` | SUPER_ADMIN |
| PATCH | `/companies/:id/active?value=` | SUPER_ADMIN |
| GET | `/users?role=` | SUPER_ADMIN |
| PATCH | `/users/:id/active?value=` | SUPER_ADMIN |

## Temps réel (Socket.IO)

Connexion : `io("http://localhost:3000", { auth: { token } })`.

| Sens | Événement | Contenu |
|---|---|---|
| app → serveur | `driver:location` | `{ lat, lng }` (livreur, toutes les ~5 s) |
| app → serveur | `delivery:watch` / `delivery:unwatch` | id de la course à suivre |
| serveur → app | `driver:location` | `{ deliveryId?, driverId, lat, lng, at }` |
| serveur → app | `delivery:updated` | `{ id, status }` → recharger la course |
| serveur → livreurs | `deliveries:changed` | recharger les courses disponibles |

Le gérant d'entreprise reçoit les positions de ses livreurs, le SA celles de tous les livreurs.

> `synchronize: true` (TypeORM) crée les tables automatiquement en développement. À remplacer par des migrations avant la production.
