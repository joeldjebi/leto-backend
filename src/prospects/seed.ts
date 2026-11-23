import { Prospect } from "./prospect.entity";

type Seed = Pick<
  Prospect,
  "name" | "country" | "city" | "priority" | "description"
> &
  Partial<
    Pick<
      Prospect,
      | "website"
      | "phone"
      | "whatsapp"
      | "email"
      | "facebook"
      | "instagram"
      | "linkedin"
      | "notes"
    >
  >;

/**
 * Liste de départ : entreprises de livraison d'Abidjan et de la sous-région (recherche du 23/11/2026).
 * Contacts relevés sur leurs sites, pages officielles ou annuaires ; à vérifier avant le premier message.
 * Priorité : 1 = livre des boutiques sans outil visible, 2 = à tenter, 3 = a déjà son app (argument : économie, marque blanche).
 */
export const PROSPECT_SEED: Seed[] = [
  {
    name: "ZOLIV EXPRESS",
    country: "CI",
    city: "Abidjan",
    priority: 1,
    description:
      "Livraison pour boutiques, avec son propre site de commande. Déjà contactée sur les réseaux",
    notes:
      "Introuvable : aucun site, page sociale ni fiche annuaire trouvés (recherches web + GoAfricaOnline, 23/11/2026).",
  },
  {
    name: "IvoirRapid",
    country: "CI",
    city: "Abidjan",
    priority: 1,
    description:
      "Coursiers moto : colis, plis, dernier kilomètre e-commerce, du lundi au samedi",
    website: "https://ivoirrapid.ci/",
    phone: "+2250768700500",
    whatsapp: "+2250768700500",
    email: "direction@ivoirrapid.ci",
    instagram: "https://www.instagram.com/ivoirrapid.app/",
    linkedin: "https://www.linkedin.com/company/ivoirrapid-ci/",
    notes:
      "Contacts sur le site officiel (tel, lien wa.me, email). Site actif; offre d'emploi publiée août 2026. Pas de page Facebook trouvée.",
  },
  {
    name: "LIVRÉ",
    country: "CI",
    city: "Abidjan",
    priority: 1,
    description:
      "Coursiers moto et réseau de points relais, livraison en moins de 2 h",
    website: "https://www.xn--livr-epa.online/",
    phone: "+2250704789985",
    notes:
      "Téléphone trouvé dans les données structurées (JSON-LD) du site officiel. Site actif (application web). Pas de réseaux sociaux trouvés.",
  },
  {
    name: "Oyoli Express",
    country: "CI",
    city: "Abidjan",
    priority: 1,
    description: "Coursier express (annuaire GoAfricaOnline)",
    phone: "+2252722544390",
    facebook: "https://www.facebook.com/OYOLI-Express-444211342701420/",
    notes:
      "Contacts trouvés sur GoAfricaOnline (fiche 500292) : autres numéros +2250749555081, +2250143287000. Page Facebook citée par la fiche; activité non vérifiée.",
  },
  {
    name: "Sanex Express",
    country: "CI",
    city: "Abidjan",
    priority: 1,
    description: "Coursier express (annuaire GoAfricaOnline)",
    phone: "+2250759258377",
    facebook: "https://www.facebook.com/Sanexmanager",
    notes:
      "Contacts trouvés sur GoAfricaOnline (fiche 803949). Activité de la page Facebook non vérifiée.",
  },
  {
    name: "Sled Livraison",
    country: "CI",
    city: "Abidjan",
    priority: 1,
    description: "Livraison (annuaire GoAfricaOnline)",
    phone: "+2250759816098",
    notes:
      "Contacts trouvés sur GoAfricaOnline (fiche 581292) : autre numéro (standard) +2250151593103.",
  },
  {
    name: "Tatoo Express",
    country: "CI",
    city: "Abidjan",
    priority: 1,
    description: "Coursier express (annuaire GoAfricaOnline)",
    phone: "+2250707209506",
    notes: "Contact trouvé sur GoAfricaOnline (fiche 569875).",
  },
  {
    name: "Premium Express",
    country: "CI",
    city: "Abidjan",
    priority: 3,
    description: "Livraison à Abidjan à 1 000 F, a déjà une app iOS",
    website: "https://express.ci/",
    email: "info@express.ci",
    notes:
      "App iOS (Express Technologie SARL, v1.0.2). Email affiché sur express.ci (Cocody Angré Terminus 81/82); le n° +225 0702029254 est en commentaire HTML non affiché, donc non retenu.",
  },
  {
    name: "MyDelivery",
    country: "CI",
    city: "Abidjan",
    priority: 3,
    description: "Livraison de colis suivie en direct",
    website: "https://www.mydelivery-ci.com/",
    email: "contact@mydelivery-ci.com",
    notes:
      "Email trouvé sur le site officiel. Site actif. Aucun téléphone ni réseau social publié.",
  },
  {
    name: "VertJaune",
    country: "CI",
    city: "Abidjan",
    priority: 2,
    description: "Boutique en ligne avec ses propres coursiers",
    website: "https://vertjaune.com/livraison",
    email: "contact@vertjaune.com",
    notes:
      "Email trouvé sur le site officiel (boutique en ligne + livraison, Fatabe Group). Site actif. Pas de téléphone ni réseaux sociaux affichés.",
  },
  {
    name: "Yonunatangue Transport",
    country: "SN",
    city: "Dakar",
    priority: 1,
    description:
      "Livraison en moins de 60 min, paiement à la livraison, Dakar et banlieue",
    website: "https://www.yonunatanguetransport.com/",
    phone: "+221786609491",
    whatsapp: "+221786609491",
    email: "yonunatanguetransport@gmail.com",
    notes:
      "Contacts trouvés dans les données structurées du site officiel (wa.me listé). Site actif.",
  },
  {
    name: "Dakar Express",
    country: "SN",
    city: "Dakar",
    priority: 2,
    description: "Livraison de colis express, multiservices (site à vérifier)",
    website: "https://dakar.express/",
    phone: "+221773665555",
    notes:
      "Téléphone affiché sur le site officiel ('Appelez-nous au +221 77 366 55 55'). Liens sociaux du site génériques (vides). Site orienté SEO/e-commerce, à vérifier.",
  },
  {
    name: "Speedex' Dakar",
    country: "SN",
    city: "Dakar",
    priority: 2,
    description: "Coursiers motorisés, restauration",
    website: "http://www.speedex-dakar.com/",
    phone: "+221338219191",
    notes:
      "Site inaccessible le 23/11/2026 (domaine ne résout plus). Téléphone trouvé sur GoAfricaOnline (fiche 415554 'Speedex'). Activité incertaine.",
  },
  {
    name: "Livrelma",
    country: "SN",
    city: "Dakar",
    priority: 3,
    description: "Livraison moto pour l'e-commerce, déjà avec suivi GPS",
    website: "https://livrelma.sn/",
    phone: "+221775873578",
    whatsapp: "+221775873578",
    email: "contact@livrelma.sn",
    notes:
      "Contacts sur le site officiel; autre numéro +221711166846. Site actif (app 'bientôt disponible').",
  },
  {
    name: "Hope Delivery",
    country: "SN",
    city: "Dakar",
    priority: 3,
    description: "Colis à Dakar, livreurs géolocalisés",
    website: "https://hope-delivery.com/",
    phone: "+221771143649",
    email: "contact@hope-delivery.com",
    notes:
      "Contacts sur le site officiel (pied de page). Site actif. Pas de réseaux sociaux trouvés.",
  },
  {
    name: "Laly Express",
    country: "BJ",
    city: "Cotonou",
    priority: 1,
    description: "Livraison dès 500 F, entreposage",
    website: "https://www.lalyexpress.bj/",
    phone: "+2290160200303",
    facebook: "https://web.facebook.com/lalyexpressbenin/",
    instagram: "https://www.instagram.com/laly.express/",
    notes:
      "Site inaccessible le 23/11/2026 (domaine ne résout plus). Contacts trouvés sur GoAfricaOnline (fiches 503594/573732) : autre numéro +2290169595903.",
  },
  {
    name: "LE LIVREUR 2.0",
    country: "BJ",
    city: "Cotonou",
    priority: 1,
    description: "Courses express, abonnements entreprises",
    website: "https://le-livreur-2-0.vercel.app/",
    phone: "+2290147042814",
    whatsapp: "+2290147042814",
    email: "lelivreur2zero@gmail.com",
    facebook: "https://facebook.com/lelivreur2.0",
    instagram: "https://instagram.com/lelivreur2.0",
    notes:
      "Contacts sur le site officiel (commercial); support +2290147042815 (aussi WhatsApp). Site hébergé sur vercel.app.",
  },
  {
    name: "Le Coursier",
    country: "BJ",
    city: "Cotonou",
    priority: 2,
    description: "Livraison en 30 à 90 min dans le Grand Nokoué, agréé ARCEP",
    website: "https://www.lecoursier.bj/",
    phone: "+2290160609292",
    email: "onvouslivre@lecoursier.bj",
    notes:
      "Contacts sur le site officiel; autre numéro +2290160887272. GoAfricaOnline confirme +229 01 60 60 92 92 (Cadjèhoun). Pas de page Facebook trouvée.",
  },
  {
    name: "SOX SERVICES",
    country: "ML",
    city: "Bamako",
    priority: 1,
    description: "Logistique pour e-commerçants, livraison en moins de 24 h",
    website: "https://soxservicessarl.com/",
    phone: "+22376392804",
    whatsapp: "+22376392804",
    email: "contact@soxservicessarl.com",
    notes:
      "Contacts sur le site officiel (tel, wa.me, email). Site actif. Lien Facebook du site générique (vide).",
  },
  {
    name: "Loban",
    country: "MULTI",
    city: "Lomé, Bamako, Ouagadougou, Cotonou, Accra",
    priority: 1,
    description:
      "Livraison express par tricycle, moto et fourgon : Lomé, Bamako, Ouagadougou, Cotonou, Accra",
    website: "https://loban-africa.com/",
    phone: "+22898754525",
    email: "contact@loban.tg",
    facebook: "https://facebook.com/lobanapp",
    instagram: "https://instagram.com/lobanapp",
    notes:
      "Contacts sur le site officiel (siège Lomé; Togo, Mali, Burkina, Bénin, Ghana).",
  },
  {
    name: "LivreurBI",
    country: "MULTI",
    city: null,
    priority: 3,
    description:
      "Plateforme de livraison multi-pays (Dakar, Abidjan, Ouaga, Cotonou, Bamako)",
    website: "https://www.livreurbi.com/",
    facebook: "https://facebook.com/livreurbi",
    instagram: "https://instagram.com/livreurbi",
    notes:
      "Réseaux sociaux (et TikTok @livreurbi) liés depuis le site officiel; aucun téléphone ni email publié. Site actif, app iOS existante.",
  },
  {
    name: "SAN NO'O",
    country: "CM",
    city: "Douala/Yaoundé",
    priority: 1,
    description: "Flotte de motos, bureaux à Douala et Yaoundé",
    website: "https://www.sannoo.org/",
    phone: "+237650493172",
    whatsapp: "+237692797935",
    email: "contact@sannoo.org",
    facebook: "https://www.facebook.com/sannoocameroun",
    notes: "Contacts sur le site officiel (wa.me sur +237692797935).",
  },
  {
    name: "Easyflash (Easyride)",
    country: "CM",
    city: "Douala/Yaoundé",
    priority: 1,
    description: "Livraison de colis à Douala et Yaoundé, 7 h 30 à 22 h",
    website:
      "https://easyride.cm/easyflash-votre-service-de-livraison-de-colis-au-cameroun/",
    phone: "+237694431749",
    email: "commande@easyride.cm",
    facebook: "https://m.facebook.com/easyflashcm/",
    instagram: "https://instagram.com/easyflashCM/",
    linkedin: "https://www.linkedin.com/company/easyridecameroun/",
    notes:
      "Contacts sur le site officiel (numéros publiés en format local 694 431 749 / 690 801 955, indicatif ajouté); autre email contact@easyride.cm. Page Easyride : facebook.com/easyridecm. Copyright du site 2021.",
  },
  {
    name: "Coursiers Express",
    country: "CM",
    city: "Douala",
    priority: 1,
    description: "Petite société de livraison à Deido (Douala), créée en 2018",
    website: "https://coursiersxpress.com/",
    phone: "+237654991333",
    facebook: "https://www.facebook.com/CoursiersXpress/",
    notes:
      "Contacts trouvés sur l'annuaire Maligah (autres numéros +237696339290, +237693000808). Site coursiersxpress.com inaccessible le 23/11/2026 (domaine ne résout plus). Activité incertaine.",
  },
  {
    name: "K Delivery Service",
    country: "CM",
    city: "Yaoundé",
    priority: 1,
    description: "Livraisons et courses à Yaoundé depuis 2023",
    website: "https://kdeliveryservice.com/",
    phone: "+237690251193",
    email: "contact@kdeliveryservice.com",
    facebook: "https://www.facebook.com/KDelivery22/",
    notes: "Contacts sur le site officiel. Site actif.",
  },
  {
    name: "MTA Express",
    country: "CM",
    city: "Douala",
    priority: 2,
    description: "Colis dans les 10 régions, dernier kilomètre à moto",
    website: "https://www.mtacolis.cm/",
    phone: "+237640657588",
    whatsapp: "+237697974848",
    email: "commercialcmr@mtacolis.com",
    facebook: "https://web.facebook.com/mtacolis",
    instagram: "https://www.instagram.com/mta_cameroun/",
    linkedin: "https://www.linkedin.com/company/mta-gopic-cameroun/",
    notes:
      "Contacts sur le site officiel (siège Bonanjo, Douala; wa.me sur +237697974848; email affiché via script anti-spam). TikTok @mta.cameroun.",
  },
  {
    name: "Safari Quickly",
    country: "CM",
    city: "Douala/Yaoundé",
    priority: 3,
    description: "Coursiers moto, commande par app",
    website: "https://safariquickly.cm/",
    phone: "+237658130614",
    whatsapp: "+237699993545",
    email: "callcenter@safariquickly.cm",
    facebook: "https://web.facebook.com/profile.php?id=100089740223834",
    instagram: "https://www.instagram.com/safariquickly_cmr/",
    notes: "Contacts sur le site officiel (lien WhatsApp sur +237699993545).",
  },
  {
    name: "Colis'Mart",
    country: "GN",
    city: "Conakry",
    priority: 2,
    description: "Colis dans toute la Guinée",
    phone: "+224622194552",
    facebook: "https://www.facebook.com/colismart/",
    linkedin: "https://www.linkedin.com/in/colismart-sarl-a8aa83164/",
    notes:
      "Contacts trouvés sur GoAfricaOnline (fiche 569020) : autres numéros +224624828299, +224629868326. colismart.com ne répond pas (23/11/2026). Presse 2022 (WeAreTech).",
  },
  {
    name: "Guinea Magic",
    country: "GN",
    city: "Conakry",
    priority: 3,
    description:
      "Dernier kilomètre avec app de géolocalisation (activité à vérifier)",
    website: "http://magicguinee.com/",
    phone: "+224626060665",
    notes:
      "Téléphone sur le site officiel magicguinee.com (site ancien, © 2016, HTTPS en échec). Presse 2022; activité actuelle incertaine.",
  },
];
