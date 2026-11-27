import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { Setting } from '../settings/setting.entity';
import { StorageService } from '../storage/storage.service';

type Txt = { title: string; text: string };

/** Contenu de la landing page (leto.performx.online), modifiable par l'admin */
export interface LandingContent {
  hero: { badge: string; title1: string; title2: string; subtitle: string; ctaPrimary: string; ctaSecondary: string };
  steps: Txt[]; // 01 commande, 02 suivi, 03 livré
  tour: Txt;
  price: { title1: string; title2: string; text: string };
  trust: { title: string; items: Txt[] };
  pros: { companyTitle: string; companyText: string; driverTitle: string; driverText: string };
  faq: { q: string; a: string }[];
  final: Txt;
  contact: { phone: string; email: string; whatsapp: string; address: string };
  /** Application Android (APK) téléchargée par « Télécharger l'app » */
  apk: { url: string | null; version: string; sizeMb: number | null; updatedAt: string | null };
}

const DEFAULT: LandingContent = {
  hero: {
    badge: 'Livraison à Abidjan, en temps réel',
    title1: 'Vos colis livrés,',
    title2: 'partout à Abidjan.',
    subtitle: 'Un ou dix destinataires, à moto, en voiture ou en cargo. Suivez votre livreur en direct et payez en espèces à la remise du colis.',
    ctaPrimary: 'Télécharger l’app Android',
    ctaSecondary: 'Devenir partenaire',
  },
  steps: [
    { title: 'Posez l’adresse. Le prix s’affiche.', text: 'Aïcha, au Plateau, envoie un colis à Moussa, à Marcory. Elle place l’adresse sur la carte : VITE calcule le trajet par les vraies routes et affiche le prix avant de valider.' },
    { title: 'Le livreur avance. Vous le voyez.', text: 'Koffi traverse la lagune par le pont. Aïcha et Moussa suivent la moto en temps réel, même écran verrouillé, avec l’heure d’arrivée qui se met à jour.' },
    { title: 'Un code. Le bon destinataire.', text: 'Moussa donne son code à 4 chiffres : le colis ne peut être remis qu’à lui. Absent ? Le livreur prouve son passage par GPS et photo.' },
  ],
  tour: { title: 'Dix adresses. Une course. Le bon ordre.', text: 'VITE enchaîne les arrêts au plus court, ici 6 clients entre Cocody et la Riviera. Et plus il y a d’arrêts, moins chaque livraison coûte.' },
  price: { title1: '2 200 F', title2: 'maximum.', text: 'À moto, partout dans le Grand Abidjan, en livraison Standard. Le prix dépend de la distance : souvent bien moins.' },
  trust: {
    title: 'Jour et nuit, des livreurs vérifiés.',
    items: [
      { title: 'Livreurs vérifiés', text: 'Pièce d’identité, permis, carte grise et selfie contrôlés avant la première course.' },
      { title: 'Code de livraison', text: 'Chaque destinataire a son code : le colis n’est remis qu’à la bonne personne.' },
      { title: 'Preuve de passage', text: 'Absent ? Position GPS, temps d’attente et photo, consultables par l’expéditeur.' },
      { title: 'Paiement en espèces', text: 'Pas de carte. Pour les boutiques, le livreur encaisse la marchandise à la livraison.' },
    ],
  },
  pros: {
    companyTitle: 'Votre flotte, vos prix, nos clients.',
    companyText: 'Carte en direct de vos livreurs, affectation des courses, encaissements, carnet des livreurs et vos propres tarifs, dans un back-office complet.',
    driverTitle: 'Votre engin. Vos horaires.',
    driverText: 'Inscrivez-vous dans l’app avec votre pièce et les papiers de votre engin. Une fois validé par VITE, recevez les courses autour de vous, avec un son, même écran verrouillé.',
  },
  faq: [
    { q: 'Comment je paie ma livraison ?', a: 'En espèces, au livreur. Le prix est affiché et fixé avant de commander.' },
    { q: 'Combien d’adresses dans une même course ?', a: 'Jusqu’à 10 destinataires. VITE calcule l’ordre le plus court et le prix baisse avec le nombre d’arrêts.' },
    { q: 'Que se passe-t-il si le destinataire est absent ?', a: 'Le livreur attend sur place, prouve son passage (GPS et photo) et vous êtes prévenu. Vous pouvez contester depuis l’app.' },
    { q: 'L’app est-elle disponible sur iPhone ?', a: 'Pas encore : VITE est disponible sur Android (fichier APK à télécharger ici). La version iPhone arrive bientôt.' },
  ],
  final: { title: 'Votre prochain colis part maintenant.', text: 'Téléchargez VITE sur Android, posez l’adresse, c’est parti.' },
  contact: { phone: '', email: '', whatsapp: '', address: 'Abidjan, Côte d’Ivoire' },
  apk: { url: null, version: '', sizeMb: null, updatedAt: null },
};

const KEY = 'landing';
const str = (v: unknown, max: number, field: string) => {
  if (typeof v !== 'string') throw new BadRequestException(`${field} : texte attendu`);
  const t = v.trim();
  if (t.length > max) throw new BadRequestException(`${field} : ${max} caractères maximum`);
  return t;
};

@Injectable()
export class LandingService implements OnModuleInit {
  private content: LandingContent = structuredClone(DEFAULT);

  constructor(
    @InjectRepository(Setting) private settings: Repository<Setting>,
    private storage: StorageService,
  ) {}

  async onModuleInit() {
    const row = await this.settings.findOneBy({ key: KEY });
    if (row) this.content = this.merge(row.value as Partial<LandingContent>);
  }

  get(): LandingContent {
    return this.content;
  }

  get defaults(): LandingContent {
    return structuredClone(DEFAULT);
  }

  /** Fusion sur les valeurs par défaut (les nouveaux champs gardent leur texte d'origine) */
  private merge(v: Partial<LandingContent>): LandingContent {
    const d = structuredClone(DEFAULT);
    return {
      hero: { ...d.hero, ...(v.hero ?? {}) },
      steps: Array.isArray(v.steps) && v.steps.length === 3 ? v.steps : d.steps,
      tour: { ...d.tour, ...(v.tour ?? {}) },
      price: { ...d.price, ...(v.price ?? {}) },
      trust: { title: v.trust?.title ?? d.trust.title, items: Array.isArray(v.trust?.items) && v.trust!.items.length === 4 ? v.trust!.items : d.trust.items },
      pros: { ...d.pros, ...(v.pros ?? {}) },
      faq: Array.isArray(v.faq) ? v.faq : d.faq,
      final: { ...d.final, ...(v.final ?? {}) },
      contact: { ...d.contact, ...(v.contact ?? {}) },
      apk: { ...d.apk, ...(v.apk ?? {}) },
    };
  }

  /** Mise à jour par l'admin (textes, contact, FAQ), avec contrôle des longueurs */
  async update(input: Partial<LandingContent>, by: string) {
    const next = this.merge({ ...this.content, ...input, apk: this.content.apk });
    const h = next.hero;
    for (const [k, max] of [['badge', 60], ['title1', 60], ['title2', 60], ['subtitle', 300], ['ctaPrimary', 40], ['ctaSecondary', 40]] as const) h[k] = str(h[k], max, `Accueil · ${k}`);
    next.steps = next.steps.map((s, i) => ({ title: str(s.title, 80, `Étape ${i + 1} · titre`), text: str(s.text, 400, `Étape ${i + 1} · texte`) }));
    next.tour = { title: str(next.tour.title, 80, 'Tournées · titre'), text: str(next.tour.text, 400, 'Tournées · texte') };
    next.price = { title1: str(next.price.title1, 30, 'Tarifs · titre'), title2: str(next.price.title2, 30, 'Tarifs · titre 2'), text: str(next.price.text, 300, 'Tarifs · texte') };
    next.trust = { title: str(next.trust.title, 80, 'Confiance · titre'), items: next.trust.items.map((t, i) => ({ title: str(t.title, 50, `Confiance ${i + 1} · titre`), text: str(t.text, 200, `Confiance ${i + 1} · texte`) })) };
    for (const k of ['companyTitle', 'driverTitle'] as const) next.pros[k] = str(next.pros[k], 80, 'Partenaires · titre');
    for (const k of ['companyText', 'driverText'] as const) next.pros[k] = str(next.pros[k], 400, 'Partenaires · texte');
    if (next.faq.length > 12) throw new BadRequestException('12 questions maximum');
    next.faq = next.faq.map((f, i) => ({ q: str(f.q, 120, `Question ${i + 1}`), a: str(f.a, 600, `Réponse ${i + 1}`) })).filter((f) => f.q && f.a);
    next.final = { title: str(next.final.title, 80, 'Appel final · titre'), text: str(next.final.text, 200, 'Appel final · texte') };
    next.contact = {
      phone: str(next.contact.phone, 30, 'Téléphone'),
      email: str(next.contact.email, 80, 'E-mail'),
      whatsapp: str(next.contact.whatsapp, 30, 'WhatsApp'),
      address: str(next.contact.address, 120, 'Adresse'),
    };
    if (next.contact.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(next.contact.email)) throw new BadRequestException('E-mail invalide');
    return this.save(next, by);
  }

  /** Nouvelle version de l'application Android (APK) */
  async uploadApk(file: Express.Multer.File | undefined, version: string, by: string) {
    if (!file) throw new BadRequestException('Fichier APK manquant');
    if (!file.originalname?.toLowerCase().endsWith('.apk') || file.buffer.subarray(0, 2).toString('ascii') !== 'PK') {
      throw new BadRequestException('Fichier APK Android attendu (.apk)');
    }
    const name = `${randomUUID()}.apk`;
    await this.storage.save(name, file.buffer, 'application/vnd.android.package-archive');
    const next = structuredClone(this.content);
    next.apk = { url: `/uploads/${name}`, version: version.trim().slice(0, 20) || next.apk.version, sizeMb: Math.round((file.size / 1024 / 1024) * 10) / 10, updatedAt: new Date().toISOString() };
    return this.save(next, by);
  }

  async reset(by: string) {
    const keepApk = this.content.apk;
    return this.save({ ...structuredClone(DEFAULT), apk: keepApk }, by);
  }

  private async save(next: LandingContent, by: string) {
    await this.settings.save({ key: KEY, value: next, updatedBy: by });
    this.content = next;
    return this.content;
  }
}
