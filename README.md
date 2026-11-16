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

Comptes de test : `npm run seed` (client 0101010101, boutique 0202020202, livreur 0303030303 : mot de passe `test1234` ; gérant 0722222222 : `secret12`).

Un compte Super Admin (SA) est créé au premier démarrage (`SUPER_ADMIN_PHONE` / `SUPER_ADMIN_PASSWORD` dans `.env`).

## Tournées (plusieurs adresses)

Une course = un départ et 1 à 10 arrêts. L'ordre de passage est optimisé (OSRM « trip », sinon le plus proche voisin). Chaque arrêt a son destinataire, son **code à 4 chiffres** (partagé par l'expéditeur, par exemple sur WhatsApp), son montant à encaisser et son statut (`PENDING`, `DELIVERED`, `FAILED`). La course est terminée quand plus aucun arrêt n'est en attente.

Prix d'une tournée : distance totale + 300 F par arrêt supplémentaire, + 250 F par arrêt avec paiement à la livraison.

**Carnet d'adresses** (`/addresses`) : chaque destinataire est mémorisé automatiquement (par numéro de téléphone).

## Destinataire absent : preuves exigées (`src/deliveries/absence.ts`)

1. Le serveur détecte l'**arrivée** du livreur (moins de 150 m) à partir de son GPS, et l'expéditeur est prévenu (`stop:arrived`).
2. Le livreur ne peut signaler un échec que **sur place** (moins de 250 m, position de moins de 2 min).
3. Absence : **attente obligatoire** de `ABSENCE_WAIT_MIN` minutes (5 par défaut) après l'arrivée.
4. **Photo obligatoire** ; la position GPS est enregistrée.
5. L'expéditeur est prévenu (`stop:failed`) et peut **contester** : le litige remonte à l'entreprise et au SA.

La livraison reste due par l'expéditeur.

## Parcours d'une livraison

`PENDING` (en attente) → `ACCEPTED` (un livreur accepte) → `PICKED_UP` (colis récupérés) → chaque arrêt est livré (code du destinataire) ou en échec → `DELIVERED`. Le client peut annuler tant que la course est `PENDING`.

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

La course se paie **en espèces uniquement**, au livreur.

## Proposez votre prix

Sur une course en attente, un livreur peut l'accepter au prix affiché ou proposer un prix plus élevé :
- la proposition doit être supérieure au prix affiché et au plus égale au double ;
- elle est valable 2 minutes, et une nouvelle proposition du même livreur remplace la précédente ;
- le client voit les propositions en direct (événement `delivery:offers`), avec le temps d'arrivée estimé de chaque livreur ;
- s'il accepte, la course est attribuée à ce livreur, au prix proposé, et les autres propositions sont refusées ;
- les livreurs reçoivent `offer:accepted` ou `offer:rejected`.

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
| GET | `/geo/search?q=&lat=&lng=`, `/geo/reverse?lat=&lng=`, `/geo/route?fromLat=…`, `/geo/route-via?points=lat,lng;…` | connecté |
| POST | `/pricing/quote` · GET `/pricing/eta?lat=&lng=` · GET `/pricing/grid` | connecté |
| POST | `/uploads` (photo d'adresse, multipart `file`) | connecté |
| POST | `/deliveries` | CLIENT |
| GET | `/deliveries/mine`, `/deliveries/mine/:id` | CLIENT |
| POST | `/deliveries/:id/cancel` | CLIENT |
| GET | `/deliveries/available`, `/deliveries/driver` | DRIVER |
| POST | `/deliveries/:id/accept`, `/pickup`, `/deliver` | DRIVER |
| GET | `/deliveries/company` | COMPANY |
| POST | `/deliveries/:id/stops/:stopId/cod-remitted` | COMPANY |
| POST | `/deliveries/:id/stops/:stopId/deliver` `{ code }` · `/fail` `{ reason, photoUrl, note? }` | DRIVER |
| POST | `/deliveries/:id/stops/:stopId/dispute` | CLIENT |
| GET/POST/DELETE | `/addresses` | CLIENT |
| POST | `/deliveries/:id/offers` `{ price }` · GET `/offers/mine` | DRIVER |
| GET | `/deliveries/:id/offers` · POST `/offers/:id/accept` · POST `/offers/:id/decline` | CLIENT |
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
