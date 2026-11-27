# API partenaire VITE — v1

L'API partenaire permet à une application (Adjamé-Smart, une boutique en ligne…) de commander des livraisons VITE, de les suivre et d'être prévenue de chaque changement par webhook.

- Base : `https://api.leto.performx.online/partner/v1`
- Format : JSON, dates ISO 8601 (UTC), montants en francs CFA (entiers).
- Accès : clé d'API créée par VITE (back-office, page « Partenaires API »). VITE peut couper l'accès de tous les partenaires ou d'un seul : les appels répondent alors `403`.

## Authentification

```
Authorization: Bearer leto_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

La clé n'est affichée qu'une fois, à sa création. Gardez-la côté serveur, jamais dans une app mobile ou un site public. Une clé compromise se révoque depuis le back-office VITE.

| Code | Sens |
| --- | --- |
| 401 | Clé absente, invalide ou révoquée |
| 403 | API partenaire désactivée par VITE, ou votre accès désactivé |
| 400 | Données invalides (le message dit lequel) |
| 404 | Course introuvable (ou d'un autre partenaire) |

## Endpoints

### `GET /me`
Vérifie la clé. Réponse : `{ id, name, active, webhookUrl }`.

### `POST /quotes` — devis
```json
{ "pickup": { "lat": 5.355, "lng": -4.02 }, "stops": [{ "lat": 5.36, "lng": -3.98, "codAmount": 12500 }] }
```
Réponse : `distanceKm`, `durationMin`, `surchargePct` et `prices` : un prix par engin (`MOTO`, `CAR`, `CARGO`) et délai (`EXPRESS`, `STANDARD`, `SCHEDULED`).

### `POST /deliveries` — créer une course
En-tête facultatif mais recommandé : `Idempotency-Key: <votre identifiant unique>`. Renvoyer la même clé renvoie la même course, sans doublon (utile si le réseau coupe).

```json
{
  "reference": "AS-1001",
  "vehicleType": "MOTO",
  "speed": "STANDARD",
  "pickup": { "lat": 5.355, "lng": -4.02, "address": "Adjamé, Forum des marchés", "phone": "0701020304", "contactName": "Boutique Awa" },
  "stops": [
    { "lat": 5.36, "lng": -3.98, "address": "Cocody Angré", "recipientName": "Fatou", "recipientPhone": "0705060708", "codAmount": 12500, "packageDescription": "2 pagnes" }
  ],
  "comment": "Appeler avant d'arriver",
  "feePaidBy": "RECIPIENT"
}
```
- `reference` : votre numéro de commande, renvoyé partout.
- `codAmount` : montant à encaisser en espèces auprès du destinataire (paiement à la livraison).
- `feePaidBy` : qui paie la livraison. `SENDER` (défaut) : payée au livreur au départ. `RECIPIENT` : chaque destinataire paie sa part au livreur, en espèces, à la remise (`feeDue` sur chaque arrêt) ; un colis non livré est payé par l'expéditeur au retour.
- `paymentRequired` (par arrêt) : la marchandise est payée en ligne (ex. PI-SPI). Le livreur ne peut pas remettre le colis tant que vous n'avez pas confirmé le paiement (endpoint ci-dessous).
- `companyId` (facultatif) : réserver la course à une entreprise de livraison précise.

Réponse : la course (format ci-dessous). Elle part tout de suite vers les livreurs.

### `GET /deliveries/:id` et `GET /deliveries?reference=AS-1001`
Une course, ou vos 50 dernières (filtrables par référence).

### `POST /deliveries/:id/cancel`
`{ "reason": "Client injoignable" }`. Possible tant que le livreur n'a pas récupéré le colis ; des frais de déplacement peuvent s'appliquer si le livreur est déjà en route.

### `POST /deliveries/:id/stops/:stopId/payment-confirmed`
Confirme que la marchandise de cet arrêt est payée (par exemple : la boutique a reçu le virement PI-SPI). Le livreur est prévenu et peut remettre le colis. Webhook : `stop.payment_confirmed`.

### `GET /statement?from=2026-12-01&to=2026-12-31`
Relevé des montants encaissés à la livraison : `codCollected`, `codRemitted` (déjà reversés), `codPending`, `stopsDelivered`, `stopsFailed`.

### Propositions de prix des livreurs
Tant que la course attend un livreur, un livreur peut proposer un prix plus élevé (2 min pour répondre).
- `GET /deliveries/:id/offers` : `[{ id, price, counterPrice, awaiting: "CLIENT" | "DRIVER", minCounter, expiresAt, driver: { name }, etaMin }]`
- `POST /offers/:id/accept` : la course est attribuée au livreur à son prix.
- `POST /offers/:id/decline` : proposition refusée.
- `POST /offers/:id/counter` `{ price }` : contre-proposition (une seule par proposition), entre `minCounter` et `price − 50`. Le livreur a 2 min pour l'accepter (course attribuée à ce prix) ou la refuser.

### `GET /geo/search?q=palmeraie cocody` — recherche d'adresse
Jusqu'à 10 lieux `{ label, sublabel, lat, lng }` (quartiers et lieux d'Abidjan). Facultatif : `lat` et `lng` pour favoriser les lieux proches.

### `GET /geo/reverse?lat=5.36&lng=-3.97` — adresse d'un point
`{ label, sublabel, commune }` : à afficher au client pour qu'il vérifie le point de livraison.

## Format d'une course

```json
{
  "id": "…", "reference": "AS-1001", "status": "PICKED_UP",
  "price": 1500, "currency": "XOF", "distanceKm": 6.2, "durationMin": 21,
  "trackingUrl": "https://leto.performx.online/#/suivi/…",
  "pickup": { "address": "…", "lat": 5.355, "lng": -4.02, "phone": "…" },
  "driver": { "name": "Bakary", "phone": "…", "vehicleType": "MOTO", "plate": "…", "position": { "lat": 5.358, "lng": -4.0, "at": "…" } },
  "feePaidBy": "RECIPIENT",
  "stops": [{ "id": "…", "position": 0, "status": "PENDING", "codAmount": 0, "feeDue": 1500, "paymentRequired": true, "paymentConfirmedAt": null, "confirmationCode": "4821", "deliveredAt": null, "failureReason": null, "codRemittedAt": null }],
  "returnRequired": false, "returnedAt": null, "acceptedAt": "…", "pickedUpAt": "…", "deliveredAt": null, "createdAt": "…"
}
```
- `status` : `PENDING` (cherche un livreur), `ACCEPTED`, `PICKED_UP`, `DELIVERED` (tous les arrêts traités), `CANCELLED`.
- Arrêt : `PENDING`, `DELIVERED`, `FAILED` (absent, refus…), `CANCELLED`.
- `confirmationCode` : à communiquer au destinataire ; le livreur le lui demande à la remise.
- Téléphone et position du livreur : seulement pendant la course.

## Webhooks

VITE envoie un `POST` JSON à votre adresse à chaque événement :

| Événement | Quand |
| --- | --- |
| `delivery.created` | Course créée |
| `delivery.accepted` | Un livreur l'a acceptée |
| `delivery.picked_up` | Colis récupéré |
| `stop.delivered` / `stop.failed` / `stop.cancelled` | Un arrêt est livré, en échec ou annulé (`stopId`) |
| `stop.payment_confirmed` | Paiement de la marchandise confirmé (`stopId`) |
| `delivery.completed` | Tous les arrêts traités |
| `delivery.returned` | Colis non livrés rapportés au départ |
| `delivery.cancelled` | Course annulée |
| `ping` | Test envoyé depuis le back-office VITE |

Corps : `{ "id": "evt_…", "event": "stop.delivered", "createdAt": "…", "stopId": "…", "delivery": { …course… } }`.

En-têtes : `X-Leto-Event`, `X-Leto-Delivery`, `X-Leto-Signature: t=<horodatage>,v1=<signature>`.

**Vérifier la signature** (obligatoire) : `HMAC_SHA256(secret, "<t>.<corps brut>")` en hexadécimal doit être égal à `v1`. Refusez aussi un `t` vieux de plus de 5 minutes.

```js
const [t, v1] = header.split(',').map((x) => x.split('=')[1]);
const ok = crypto.createHmac('sha256', SECRET).update(`${t}.${rawBody}`).digest('hex') === v1;
```

Répondez `2xx` en moins de 10 secondes. Sinon VITE relance après 30 s, 2 min, 10 min, 1 h, 6 h et 24 h, puis abandonne (relance manuelle possible depuis le back-office). Un même événement peut arriver deux fois : dédoublonnez avec `id`.
