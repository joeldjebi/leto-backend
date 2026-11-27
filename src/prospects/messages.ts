/**
 * Messages de premier contact, adaptés à chaque entreprise de la liste de départ.
 * « {prenom} » est remplacé par le nom de l'expéditeur dans le back-office.
 */
export const VIDEO_URL = 'https://vite.ci/video';

type Pitch = {
  /** Phrase d'accroche liée à leur activité */
  hook: string;
  /** Objet de l'e-mail */
  subject: string;
  /** Hors Côte d'Ivoire : présentation en visio */
  remote?: boolean;
  /** Message WhatsApp entièrement personnalisé (relance, etc.) */
  wa?: string;
  /** Paragraphe d'introduction de l'e-mail (remplace l'introduction standard) */
  intro?: string;
};

const PITCHES: Record<string, Pitch> = {
  'ZOLIV EXPRESS': {
    subject: 'ZOLIV EXPRESS × VITE : suite à mon message, 15 minutes de présentation ?',
    hook: 'Votre site permet déjà à vos boutiques de commander. VITE y ajoute l’app livreur (le livreur accepte et exécute la course), le suivi en temps réel pour vos clients et la carte de vos livreurs en direct.',
    wa: 'Bonjour ZOLIV EXPRESS 👋\nC’est {prenom}, fondateur de VITE : je reviens vers vous suite à mon message sur vos réseaux.\nVotre site permet déjà à vos boutiques de commander. VITE y ajoute l’app livreur (acceptation et exécution de la course), le suivi en temps réel pour vos clients et la carte de vos livreurs en direct.\nSeriez-vous disponible 15 minutes cette semaine pour une présentation ?\nVidéo : ' + VIDEO_URL,
    intro: 'Je reviens vers vous suite à mon message sur vos réseaux sociaux.',
  },
  IvoirRapid: {
    subject: 'IvoirRapid : vos e-commerçants commandent leurs courses seuls, vous suivez tout en direct',
    hook: 'Vous gérez colis, plis et dernier kilomètre e-commerce à moto : avec VITE, vos e-commerçants créent leurs courses eux-mêmes, sans appel ni message, et vos coursiers les acceptent depuis leur téléphone.',
  },
  'LIVRÉ': {
    subject: 'LIVRÉ : vos coursiers et vos livraisons en moins de 2 h, sur une seule carte en direct',
    hook: 'Avec vos coursiers et vos points relais, tenir la promesse des 2 h demande de tout voir : VITE vous montre chaque livreur et chaque course en direct sur une carte, et vos clients suivent leur colis par un simple lien.',
  },
  'Oyoli Express': {
    subject: 'Oyoli Express : vos clients commandent un coursier en quelques secondes',
    hook: 'Pour un service de coursiers express, VITE remplace les appels et les messages : vos clients commandent dans l’app, vos coursiers acceptent directement, et chacun suit la course en temps réel.',
  },
  'Sanex Express': {
    subject: 'Sanex Express : des courses commandées, acceptées et suivies en temps réel',
    hook: 'Pour un service express, chaque minute perdue au téléphone coûte : avec VITE, vos clients commandent seuls, le coursier accepte en un geste et vous voyez toute votre équipe sur la carte.',
  },
  'Sled Livraison': {
    subject: 'Sled Livraison : vos livraisons organisées et suivies en direct',
    hook: 'VITE donne à une société de livraison comme la vôtre tout l’outil d’un grand acteur, sans développement : une app de commande pour vos clients, une app pour vos livreurs et un tableau de bord en temps réel.',
  },
  'Tatoo Express': {
    subject: 'Tatoo Express : vos coursiers visibles en direct, vos clients informés',
    hook: 'Vos clients veulent savoir où est leur coursier sans vous appeler : avec VITE, ils commandent dans l’app et suivent le livreur en temps réel, pendant que vous pilotez toute l’équipe sur une carte.',
  },
  'Premium Express': {
    subject: 'Premium Express : app livreurs, suivi client et carte en direct, prêts à l’emploi',
    hook: 'Vous avez déjà votre app iOS : VITE peut la compléter avec une app livreurs (acceptation directe des courses), un lien de suivi en temps réel pour vos clients et un tableau de bord avec la carte de vos livreurs, sans développement de votre côté.',
  },
  MyDelivery: {
    subject: 'MyDelivery : commande en libre-service pour les boutiques et carte de toute votre flotte',
    hook: 'Vous proposez déjà le suivi en direct : VITE y ajoute la commande en libre-service pour les boutiques, l’acceptation directe par le livreur et une carte de toute votre flotte en temps réel, prêts à l’emploi.',
  },
  VertJaune: {
    subject: 'VertJaune : vos coursiers équipés d’une app, vos clients suivent leur commande',
    hook: 'Vous livrez votre boutique avec vos propres coursiers : VITE leur donne une app pour accepter et exécuter chaque livraison, vos clients suivent leur commande en temps réel et vous voyez tout sur une carte, sans développer d’outil.',
  },
  'Yonunatangue Transport': {
    remote: true,
    subject: 'Yonunatangue Transport : vos livraisons en moins de 60 min, suivies minute par minute',
    hook: 'Vous promettez la livraison en moins de 60 minutes à Dakar : avec VITE, vos clients commandent en quelques secondes, le livreur accepte aussitôt et chacun suit la course minute par minute.',
  },
  'Dakar Express': {
    remote: true,
    subject: 'Dakar Express : vos colis express commandés et suivis en temps réel',
    hook: 'Pour vos colis express à Dakar, VITE met tout dans le téléphone : vos clients commandent, vos livreurs acceptent et livrent, et vous voyez chaque course en direct sur la carte.',
  },
  "Speedex' Dakar": {
    remote: true,
    subject: "Speedex' : vos restaurants commandent un coursier, le client suit sa commande",
    hook: 'Pour la livraison de restaurants, chaque minute compte : vos restaurants commandent dans l’app, vos coursiers acceptent directement et le client suit sa commande en temps réel.',
  },
  Livrelma: {
    remote: true,
    subject: 'Livrelma : une plateforme complète déjà prête, en attendant votre app',
    hook: 'Votre app est annoncée « bientôt disponible » : VITE est déjà prête (app boutiques, app livreurs, suivi en temps réel, tableau de bord avec la carte) et peut vous faire gagner des mois de développement.',
  },
  'Hope Delivery': {
    remote: true,
    subject: 'Hope Delivery : de la géolocalisation des livreurs au suivi partagé au client',
    hook: 'Vos livreurs sont déjà géolocalisés : VITE va plus loin avec la commande directe par vos clients, l’acceptation des courses par le livreur et un lien de suivi en temps réel envoyé au destinataire.',
  },
  'Laly Express': {
    remote: true,
    subject: 'Laly Express : des courses dès 500 F, gérées sans appels',
    hook: 'Avec des livraisons dès 500 F, chaque course doit coûter peu à gérer : VITE automatise la prise de commande, l’attribution au livreur et le suivi, sans un seul appel.',
  },
  'LE LIVREUR 2.0': {
    remote: true,
    subject: 'LE LIVREUR 2.0 : vos entreprises abonnées commandent et suivent leurs courses seules',
    hook: 'Vos entreprises abonnées pourraient commander leurs courses elles-mêmes depuis une app et suivre le livreur en direct, pendant que vous pilotez toute votre équipe sur une carte.',
  },
  'Le Coursier': {
    remote: true,
    subject: 'Le Coursier : vos délais de 30 à 90 min tenus, avec tous vos coursiers sur une carte',
    hook: 'Pour tenir vos délais de 30 à 90 minutes dans le Grand Nokoué, VITE vous montre tous vos coursiers en direct sur une carte et permet à vos clients de suivre leur livraison en temps réel.',
  },
  'SOX SERVICES': {
    remote: true,
    subject: 'SOX SERVICES : vos e-commerçants créent leurs livraisons, chaque colis suivi jusqu’au client',
    hook: 'Vos e-commerçants pourraient créer leurs livraisons eux-mêmes dans une app, vos livreurs les accepter directement, et chaque colis être suivi en temps réel jusqu’au client.',
  },
  Loban: {
    remote: true,
    subject: 'Loban : toutes vos villes et tous vos livreurs, sur un seul tableau de bord en direct',
    hook: 'Avec des livraisons dans cinq pays, VITE vous donne un seul outil : vos clients commandent dans l’app, vos livreurs (tricycle, moto ou fourgon) acceptent les courses, et vous suivez tout en direct sur la carte.',
  },
  LivreurBI: {
    remote: true,
    subject: 'LivreurBI × VITE : échange entre plateformes de livraison',
    hook: 'Vous opérez déjà une plateforme de livraison dans plusieurs pays, dont Abidjan : j’aimerais échanger avec vous, sur un partenariat ou sur ce que VITE apporte côté suivi en temps réel et pilotage des livreurs.',
  },
  "SAN NO'O": {
    remote: true,
    subject: "SAN NO'O : votre flotte de motos à Douala et Yaoundé, en direct sur une carte",
    hook: 'Avec une flotte de motos sur deux villes, VITE vous montre chaque livreur en direct sur la carte ; vos clients commandent dans l’app et vos livreurs acceptent directement les courses.',
  },
  'Easyflash (Easyride)': {
    remote: true,
    subject: 'Easyflash : vos colis commandés et suivis en temps réel, de 7 h 30 à 22 h',
    hook: 'De 7 h 30 à 22 h à Douala et Yaoundé, vos clients pourraient commander un livreur dans l’app à tout moment, et suivre le colis en temps réel jusqu’à la livraison.',
  },
  'Coursiers Express': {
    remote: true,
    subject: 'Coursiers Express : vos courses commandées dans une app, sans appels',
    hook: 'Pour une équipe de coursiers comme la vôtre, VITE remplace les appels : vos clients commandent dans l’app, vos coursiers acceptent directement et vous suivez chaque course en direct.',
  },
  'K Delivery Service': {
    remote: true,
    subject: 'K Delivery Service : vos livraisons à Yaoundé, commandées et suivies en temps réel',
    hook: 'Pour vos livraisons et courses à Yaoundé, VITE donne à vos clients une app pour commander, à vos livreurs une app pour accepter les courses, et à vous une carte en direct de toute l’équipe.',
  },
  'MTA Express': {
    remote: true,
    subject: 'MTA Express : votre dernier kilomètre à moto, suivi en temps réel',
    hook: 'Pour votre dernier kilomètre à moto, VITE permet d’attribuer les courses aux livreurs en un geste et de suivre chaque colis en direct, avec un lien de suivi pour le destinataire.',
  },
  'Safari Quickly': {
    remote: true,
    subject: 'Safari Quickly × VITE : suivi en temps réel et pilotage des coursiers',
    hook: 'Vous avez déjà votre app de commande : VITE peut la compléter avec un suivi en temps réel partagé au client et un tableau de bord où vous voyez vos coursiers bouger sur la carte.',
  },
  "Colis'Mart": {
    remote: true,
    subject: "Colis'Mart : votre dernier kilomètre à Conakry, suivi en temps réel",
    hook: 'Pour vos livraisons à Conakry, VITE met tout dans le téléphone : vos clients commandent, vos livreurs acceptent et livrent, et vous suivez chaque colis en direct.',
  },
  'Guinea Magic': {
    remote: true,
    subject: 'Guinea Magic × VITE : commande, livreurs et suivi client sur une seule plateforme',
    hook: 'Vous faites déjà le dernier kilomètre avec la géolocalisation : VITE ajoute la commande directe par vos clients, l’acceptation des courses par le livreur et un lien de suivi en temps réel pour le destinataire.',
  },
};

const ask = (remote?: boolean) =>
  remote
    ? 'Auriez-vous 15 minutes pour une présentation en visio (WhatsApp ou Google Meet) ?'
    : 'Auriez-vous 15 minutes pour une présentation, dans vos locaux ou en visio ?';

export interface ProspectMessages {
  waMessage: string;
  emailSubject: string;
  emailBody: string;
}

/** Messages WhatsApp et e-mail d'une entreprise de la liste de départ (null si elle n'y est pas) */
export function messagesFor(name: string): ProspectMessages | null {
  const p = PITCHES[name];
  if (!p) return null;
  const waMessage =
    p.wa ??
    `Bonjour ${name} 👋\nJe suis {prenom}, fondateur de VITE, une plateforme de livraison conçue à Abidjan.\n${p.hook}\n${ask(p.remote)}\nVidéo : ${VIDEO_URL}`;
  const emailBody = [
    'Bonjour,',
    '',
    `Je suis {prenom}, fondateur de VITE, une plateforme de livraison conçue à Abidjan.${p.intro ? ` ${p.intro}` : ''}`,
    '',
    p.hook,
    '',
    'VITE, c’est :',
    '• une app pour vos clients (boutiques, e-commerçants, entreprises), qui commandent une livraison en quelques secondes ;',
    '• une app pour vos livreurs, qui acceptent la course directement et l’exécutent ;',
    '• le suivi en temps réel, partagé à vos clients par un simple lien ;',
    '• un tableau de bord où vous voyez vos livreurs se déplacer sur la carte pendant leurs livraisons.',
    '',
    `Vidéo de présentation : ${VIDEO_URL}`,
    '',
    `${ask(p.remote)} Je m’adapte à vos disponibilités.`,
    '',
    'Bien cordialement,',
    '{prenom}',
    'Fondateur, VITE',
    'vite.ci',
  ].join('\n');
  return { waMessage, emailSubject: p.subject, emailBody };
}
