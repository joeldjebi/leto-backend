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

## Tarifs

Grille par commune du Grand Abidjan, dans `src/pricing/pricing.ts` : 1 000 FCFA (même commune), 1 500 FCFA (autre commune), 2 500 FCFA (périphérie : Bingerville, Songon, Anyama). Paiement en espèces au livreur.

## Endpoints

| Méthode | Route | Rôle |
|---|---|---|
| POST | `/auth/register` | public (crée un client) |
| POST | `/auth/login` | public |
| GET | `/auth/me` | connecté |
| GET | `/pricing/communes`, `/pricing/quote?from=&to=` | public |
| POST | `/deliveries` | CLIENT |
| GET | `/deliveries/mine`, `/deliveries/mine/:id` | CLIENT |
| POST | `/deliveries/:id/cancel` | CLIENT |
| GET | `/deliveries/available`, `/deliveries/driver` | DRIVER |
| POST | `/deliveries/:id/accept`, `/pickup`, `/deliver` | DRIVER |
| GET | `/deliveries/company` | COMPANY |
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
