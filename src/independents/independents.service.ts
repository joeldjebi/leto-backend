import { NotifyService } from '../notifications/notify.service';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { Company } from '../companies/company.entity';
import { VehicleType } from '../pricing/pricing';
import { Setting } from '../settings/setting.entity';
import { TrackingGateway } from '../tracking/tracking.gateway';
import { normalizePlate, Role, User } from '../users/user.entity';
import { DOC_FIELDS, DOC_LABEL, EXPIRING, IndependentEvent, IndependentProfile, IndependentStatus, RENEWABLE, RenewableField, Renewal } from './independent-profile.entity';

export type CommissionType = 'PERCENT' | 'FIXED';

/** Règles des livreurs indépendants, fixées par le SA */
export interface IndependentsConfig {
  /** Inscriptions ouvertes dans l'app */
  registrationOpen: boolean;
  /** Interrupteur général : désactivé, aucun LI ne reçoit de course */
  enabled: boolean;
  /** Commission LETO sur chaque course d'un LI (différente des entreprises) */
  commissionType: CommissionType;
  commissionValue: number;
  /** Plafonds de la commission qu'une entreprise peut prendre sur ses LI */
  companyMaxPct: number;
  companyMaxFixed: number;
  /** LI validés avant le rattachement obligatoire : jours pour se rattacher, à partir du début de la transition */
  transitionDays: number;
  transitionStartedAt: string | null;
  /** Gains des entreprises : disponibles après ce délai (litiges), retrait minimum */
  earningsHoldHours: number;
  minWithdrawal: number;
}

/** Accès d'un livreur aux courses : entreprise (team = elle) ou LI (team = entreprise de rattachement, null en transition) */
export interface DriverAccess {
  independent: boolean;
  team: string | null;
  blocker: string | null;
}

const KEY = 'independents';
const DEFAULT: IndependentsConfig = {
  registrationOpen: false,
  enabled: true,
  commissionType: 'PERCENT',
  commissionValue: 15,
  companyMaxPct: 20,
  companyMaxFixed: 500,
  transitionDays: 30,
  transitionStartedAt: null,
  earningsHoldHours: 48,
  minWithdrawal: 5000,
};
const DAY_MS = 86_400_000;
/** Durée des liens de lecture des pièces d'identité */
const LINK_TTL_S = 15 * 60;
/** Rappel avant la fin de validité du permis et de l'assurance */
export const EXPIRY_WARN_DAYS = 30;
const EXPIRY_CHECK_MS = 60 * 60_000;
/** Livreurs validés : une seule notification aux entreprises par période */
const POOL_NOTIFY_MS = Number(process.env.POOL_NOTIFY_SEC ?? 180) * 1000;
const VEHICLE_FR: Record<string, string> = { MOTO: 'Moto', CAR: 'Voiture', CARGO: 'Cargo' };

/** Date du jour (AAAA-MM-JJ, heure d'Abidjan = UTC) */
export const today = (offsetDays = 0) => new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
/** 2027-01-31 → 31/01/2027 */
export const frDate = (d: string) => d.split('-').reverse().join('/');
/** SQL : permis et assurance encore valides (date absente = pas encore renseignée, pas bloquant) */
export const DOCS_VALID_SQL = (alias: string) =>
  `(${alias}."licenseExpiresOn" IS NULL OR ${alias}."licenseExpiresOn" >= to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'))
   AND (${alias}."insuranceExpiresOn" IS NULL OR ${alias}."insuranceExpiresOn" >= to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'))`;

export type ExpiryState = 'OK' | 'SOON' | 'EXPIRED' | 'UNKNOWN';
export const expiryState = (d: string | null): ExpiryState => (!d ? 'UNKNOWN' : d < today() ? 'EXPIRED' : d <= today(EXPIRY_WARN_DAYS) ? 'SOON' : 'OK');
/** État du permis et de l'assurance */
export const docsState = (p: { licenseExpiresOn: string | null; insuranceExpiresOn: string | null }) => ({
  license: { expiresOn: p.licenseExpiresOn, state: expiryState(p.licenseExpiresOn) },
  insurance: { expiresOn: p.insuranceExpiresOn, state: expiryState(p.insuranceExpiresOn) },
});
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (d: string) => DATE_RE.test(d) && !Number.isNaN(new Date(`${d}T00:00:00Z`).getTime()) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d);

export interface DossierInput {
  birthDate?: string;
  commune?: string;
  address?: string;
  idType?: string;
  idNumber?: string;
  emergencyName?: string;
  emergencyPhone?: string;
  vehicleType?: string;
  vehicleBrand?: string;
  vehiclePlate?: string;
  licenseNumber?: string;
  selfieUrl?: string;
  docsSelfieUrl?: string;
  idFrontUrl?: string;
  idBackUrl?: string;
  licenseUrl?: string;
  registrationUrl?: string;
  insuranceUrl?: string;
  licenseExpiresOn?: string;
  insuranceExpiresOn?: string;
  consent?: boolean;
}

/** Champs obligatoires pour envoyer le dossier, avec leur libellé */
const REQUIRED: [keyof IndependentProfile, string][] = [
  ['birthDate', 'date de naissance'],
  ['commune', 'commune'],
  ['address', 'quartier'],
  ['idType', 'type de pièce'],
  ['idNumber', 'numéro de la pièce'],
  ['vehicleType', 'type d’engin'],
  ['vehicleBrand', 'marque de l’engin'],
  ['vehiclePlate', 'immatriculation'],
  ['selfieUrl', 'selfie'],
  ['docsSelfieUrl', 'photo avec vos documents en main'],
  ['idFrontUrl', 'pièce d’identité (recto)'],
  ['idBackUrl', 'pièce d’identité (verso)'],
  ['licenseUrl', 'permis de conduire'],
  ['registrationUrl', 'carte grise'],
  ['insuranceUrl', 'assurance'],
  ['licenseExpiresOn', 'date de fin de validité du permis'],
  ['insuranceExpiresOn', 'date de fin de validité de l’assurance'],
];

/**
 * Livreurs indépendants (LI) : inscription dans l'app, dossier (identité, engin, photos),
 * validation par LETO, règles et commission propres.
 */
@Injectable()
export class IndependentsService implements OnModuleInit, OnModuleDestroy {
  private cfg: IndependentsConfig = { ...DEFAULT };
  private logger = new Logger(IndependentsService.name);
  private expiryTimer?: NodeJS.Timeout;
  private poolQueue = new Set<string>();
  private poolTimer?: NodeJS.Timeout;

  constructor(
    private db: DataSource,
    @InjectRepository(Setting) private settings: Repository<Setting>,
    @InjectRepository(IndependentProfile) private profiles: Repository<IndependentProfile>,
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(Company) private companies: Repository<Company>,
    private tracking: TrackingGateway,
    private notify: NotifyService,
  ) {}

  async onModuleInit() {
    const row = await this.settings.findOneBy({ key: KEY });
    if (row) this.cfg = { ...DEFAULT, ...(row.value as Partial<IndependentsConfig>) };
    // Rattachement obligatoire : les LI déjà validés gardent leur accès pendant la transition
    if (!this.cfg.transitionStartedAt) {
      this.cfg.transitionStartedAt = new Date().toISOString();
      await this.settings.save({ key: KEY, value: this.cfg, updatedBy: 'Rattachement obligatoire' });
      await this.db.query(
        `UPDATE independent_profiles SET "legacyUntil" = $1 WHERE status IN ('APPROVED', 'SUSPENDED') AND "affiliatedCompanyId" IS NULL`,
        [this.transitionEnd()],
      );
    }
    // Permis et assurance : rappels avant la fin de validité, blocage le jour d'après
    const run = () => this.checkExpiries().catch((e) => this.logger.warn(`Rappels d'expiration : ${e}`));
    setTimeout(run, 20_000).unref();
    this.expiryTimer = setInterval(run, EXPIRY_CHECK_MS);
    this.expiryTimer.unref();
  }

  onModuleDestroy() {
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    if (this.poolTimer) clearTimeout(this.poolTimer);
  }

  /** Nouveau livreur dans le vivier : les entreprises sont prévenues, regroupé sur quelques minutes */
  private queuePoolNotice(profileId: string) {
    this.poolQueue.add(profileId);
    if (this.poolTimer) return;
    this.poolTimer = setTimeout(() => {
      this.poolTimer = undefined;
      this.flushPoolNotice().catch((e) => this.logger.warn(`Notification du vivier : ${e}`));
    }, POOL_NOTIFY_MS);
    this.poolTimer.unref();
  }

  async flushPoolNotice() {
    const ids = [...this.poolQueue];
    this.poolQueue.clear();
    if (!ids.length || !this.cfg.enabled) return;
    // Toujours libres et validés (pas rattachés ni suspendus entre-temps)
    const rows: { name: string; vehicleType: string | null; commune: string | null }[] = await this.db.query(
      `SELECT u.name, p."vehicleType", p.commune FROM independent_profiles p JOIN users u ON u.id = p."userId"
        WHERE p.id = ANY($1::uuid[]) AND p.status = 'APPROVED' AND p."affiliatedCompanyId" IS NULL AND u.active
        ORDER BY p."reviewedAt"`,
      [ids],
    );
    if (!rows.length) return;
    const describe = (r: (typeof rows)[number]) => [r.name, r.vehicleType ? VEHICLE_FR[r.vehicleType] : null, r.commune].filter(Boolean).join(' · ');
    const title = rows.length === 1 ? 'Nouveau livreur indépendant disponible' : `${rows.length} nouveaux livreurs indépendants disponibles`;
    const names = rows.slice(0, 3).map((r) => r.name).join(', ');
    const body = rows.length === 1 ? `${describe(rows[0])}. Invitez-le depuis le vivier.` : `${names}${rows.length > 3 ? ` et ${rows.length - 3} autre(s)` : ''}. Invitez-les depuis le vivier.`;
    const companies: { id: string }[] = await this.db.query(`SELECT id FROM companies WHERE NOT independent AND active AND status = 'APPROVED'`);
    for (const c of companies) {
      this.notify.office({ companyId: c.id }, 'POOL', { title, body, link: '/independants' });
      this.tracking.emitToCompany(c.id, 'affiliations:changed', {});
    }
  }

  /** Fin de la période de transition */
  transitionEnd() {
    return new Date(new Date(this.cfg.transitionStartedAt ?? Date.now()).getTime() + this.cfg.transitionDays * DAY_MS);
  }

  /** Commission d'une entreprise sur un LI, ramenée sous les plafonds de LETO */
  capRule(type: CommissionType, value: number) {
    return type === 'PERCENT' ? Math.min(value, this.cfg.companyMaxPct) : Math.min(value, this.cfg.companyMaxFixed);
  }

  /** Accès aux courses d'un livreur (entreprise ou LI) */
  async access(companyId: string | null): Promise<DriverAccess> {
    if (!companyId) return { independent: false, team: null, blocker: 'Livreur sans entreprise : contactez LETO' };
    const c = await this.companies.findOneBy({ id: companyId });
    if (!c?.independent) return { independent: false, team: companyId, blocker: null };
    const p = await this.profiles.findOneBy({ companyId });
    return { independent: true, team: p?.affiliatedCompanyId ?? null, blocker: await this.blocker(companyId, p) };
  }

  /** Le livreur peut-il voir / prendre cette course ? (LI : jamais de paiement à la livraison) */
  canTake(a: DriverAccess, d: { forIndependents: boolean; targetCompanyId: string | null }, hasCod: boolean) {
    if (!a.independent) return !d.forIndependents && (!d.targetCompanyId || d.targetCompanyId === a.team);
    if (a.blocker || hasCod) return false;
    return d.forIndependents || !d.targetCompanyId || (!!a.team && d.targetCompanyId === a.team);
  }

  /** LI pouvant travailler : entreprise individuelle → entreprise de rattachement (null en transition) */
  async working(): Promise<Map<string, string | null>> {
    if (!this.cfg.enabled) return new Map();
    const rows: { companyId: string; affiliatedCompanyId: string | null }[] = await this.db.query(
      `SELECT "companyId", "affiliatedCompanyId" FROM independent_profiles
        WHERE status = 'APPROVED' AND ("affiliatedCompanyId" IS NOT NULL OR "legacyUntil" > now()) AND ${DOCS_VALID_SQL('independent_profiles')}`,
    );
    return new Map(rows.map((r) => [r.companyId, r.affiliatedCompanyId]));
  }

  // ---------- Règles ----------

  get config(): IndependentsConfig {
    return { ...this.cfg };
  }

  async updateConfig(input: Partial<IndependentsConfig>, by: string) {
    const next = { ...this.cfg };
    if (input.registrationOpen !== undefined) next.registrationOpen = !!input.registrationOpen;
    if (input.enabled !== undefined) next.enabled = !!input.enabled;
    const num = (v: unknown, name: string, min: number, max: number) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < min || n > max) throw new BadRequestException(`${name} : valeur entre ${min} et ${max} attendue`);
      return n;
    };
    if (input.companyMaxPct !== undefined) next.companyMaxPct = num(input.companyMaxPct, 'Commission entreprise maximum (%)', 0, 100);
    if (input.companyMaxFixed !== undefined) next.companyMaxFixed = Math.round(num(input.companyMaxFixed, 'Commission entreprise maximum (F)', 0, 100_000));
    if (input.earningsHoldHours !== undefined) next.earningsHoldHours = Math.round(num(input.earningsHoldHours, 'Délai avant retrait (heures)', 0, 720));
    if (input.minWithdrawal !== undefined) next.minWithdrawal = Math.round(num(input.minWithdrawal, 'Retrait minimum (F)', 0, 1_000_000));
    const daysChanged = input.transitionDays !== undefined && Number(input.transitionDays) !== next.transitionDays;
    if (input.transitionDays !== undefined) next.transitionDays = Math.round(num(input.transitionDays, 'Période de transition (jours)', 0, 365));
    if (input.commissionType !== undefined || input.commissionValue !== undefined) {
      const type = input.commissionType ?? next.commissionType;
      const value = Number(input.commissionValue ?? next.commissionValue);
      if (type !== 'PERCENT' && type !== 'FIXED') throw new BadRequestException('Commission : pourcentage ou montant fixe');
      if (type === 'PERCENT' && (!Number.isFinite(value) || value < 0 || value > 100)) throw new BadRequestException('Pourcentage entre 0 et 100');
      if (type === 'FIXED' && (!Number.isInteger(value) || value < 0 || value > 1_000_000)) throw new BadRequestException('Commission fixe : nombre entier');
      next.commissionType = type;
      next.commissionValue = type === 'PERCENT' ? Math.round(value * 100) / 100 : value;
    }
    await this.settings.save({ key: KEY, value: next, updatedBy: by });
    this.cfg = next;
    // Transition prolongée ou raccourcie : nouvelle date pour les LI concernés
    if (daysChanged) {
      await this.db.query(`UPDATE independent_profiles SET "legacyUntil" = $1 WHERE "legacyUntil" IS NOT NULL`, [this.transitionEnd()]);
    }
    // Désactivation générale : les LI ne voient plus les courses
    this.tracking.server?.to('drivers').emit('deliveries:changed', {});
    return this.config;
  }

  /** Infos publiques : inscriptions ouvertes ? service actif ? livreurs validés */
  async publicInfo() {
    const [row] = await this.db.query(
      `SELECT count(*)::int AS approved,
              count(*) FILTER (WHERE u."lastLocationAt" > now() - interval '2 minutes')::int AS online
         FROM independent_profiles p JOIN users u ON u.id = p."userId"
        WHERE p.status = 'APPROVED' AND u.active`,
    );
    return { registrationOpen: this.cfg.registrationOpen, enabled: this.cfg.enabled, approved: row.approved, online: this.cfg.enabled ? row.online : 0 };
  }

  // ---------- Accès aux courses ----------

  /** Entreprise individuelle d'un LI ? */
  async isIndependent(companyId: string | null) {
    if (!companyId) return false;
    return (await this.companies.findOneBy({ id: companyId }))?.independent === true;
  }

  /** Raison pour laquelle un LI ne peut pas travailler (null = il peut) */
  async blocker(companyId: string, profile?: IndependentProfile | null): Promise<string | null> {
    if (!this.cfg.enabled) return 'Les livreurs indépendants sont désactivés par LETO pour le moment';
    const p = profile === undefined ? await this.profiles.findOneBy({ companyId }) : profile;
    switch (p?.status) {
      case IndependentStatus.APPROVED: {
        const expired = this.expiredText(p);
        if (expired) return expired;
        if (p.affiliatedCompanyId) return null;
        if (p.legacyUntil && p.legacyUntil.getTime() > Date.now()) return null;
        return 'Rattachez-vous à une entreprise de livraison pour recevoir des courses : acceptez une invitation dans l’app';
      }
      case IndependentStatus.PENDING:
        return 'Votre dossier est en cours de vérification par LETO';
      case IndependentStatus.REJECTED:
        return 'Votre dossier a été refusé : corrigez-le dans l’app';
      case IndependentStatus.SUSPENDED:
        return 'Votre compte est suspendu par LETO';
      default:
        return 'Complétez et envoyez votre dossier pour commencer';
    }
  }

  /** Permis ou assurance expiré : message pour le livreur (null = documents valides) */
  expiredText(p: IndependentProfile) {
    const lic = expiryState(p.licenseExpiresOn) === 'EXPIRED';
    const ins = expiryState(p.insuranceExpiresOn) === 'EXPIRED';
    if (!lic && !ins) return null;
    const what = lic && ins ? 'Votre permis et votre assurance ont expiré' : lic ? 'Votre permis a expiré' : 'Votre assurance a expiré';
    return `${what} : envoyez le nouveau document dans l’app, rubrique « Mes documents »`;
  }

  /** Entreprises individuelles des LI validés (carte du client) */
  async approvedCompanyIds(): Promise<Set<string>> {
    if (!this.cfg.enabled) return new Set();
    const rows = await this.profiles.find({ where: { status: IndependentStatus.APPROVED }, select: { companyId: true } });
    return new Set(rows.map((r) => r.companyId));
  }

  // ---------- Inscription (app) ----------

  async register(dto: { name: string; phone: string; password: string }) {
    if (!this.cfg.registrationOpen) throw new ForbiddenException('Les inscriptions des livreurs indépendants sont fermées pour le moment');
    if (await this.users.existsBy({ phone: dto.phone })) throw new ConflictException('Ce numéro est déjà utilisé');
    const userId = await this.db.transaction(async (m) => {
      const company = await m.save(Company, { name: dto.name.trim(), phone: dto.phone, independent: true });
      const user = await m.save(User, {
        name: dto.name.trim(),
        phone: dto.phone,
        passwordHash: await bcrypt.hash(dto.password, 10),
        role: Role.DRIVER,
        companyId: company.id,
      });
      await m.save(IndependentProfile, {
        userId: user.id,
        companyId: company.id,
        status: IndependentStatus.DRAFT,
        history: [{ at: new Date().toISOString(), action: 'CREATED' }],
      });
      return user.id;
    });
    return this.users.findOneBy({ id: userId });
  }

  private async mine(userId: string) {
    const p = await this.profiles.findOneBy({ userId });
    if (!p) throw new NotFoundException('Vous n’êtes pas livreur indépendant');
    return p;
  }

  /** Dossier du livreur (avec des liens de lecture de ses photos) */
  async me(userId: string) {
    return this.withLinks(await this.mine(userId));
  }

  /** Le livreur remplit son dossier (avant envoi, ou après un refus) */
  async update(userId: string, dto: DossierInput) {
    const p = await this.mine(userId);
    if (p.status !== IndependentStatus.DRAFT && p.status !== IndependentStatus.REJECTED) {
      throw new BadRequestException(p.status === IndependentStatus.PENDING ? 'Dossier en cours de vérification : modification impossible' : 'Dossier déjà validé : contactez LETO pour le modifier');
    }
    const fields = ['birthDate', 'commune', 'address', 'idType', 'idNumber', 'emergencyName', 'emergencyPhone', 'vehicleType', 'vehicleBrand', 'vehiclePlate', 'licenseNumber', ...DOC_FIELDS] as const;
    for (const k of fields) {
      const v = dto[k as keyof DossierInput];
      if (v !== undefined) (p as unknown as Record<string, unknown>)[k] = typeof v === 'string' ? v.trim() || null : v;
    }
    if (p.vehiclePlate) p.vehiclePlate = p.vehiclePlate.toUpperCase();
    for (const k of ['licenseExpiresOn', 'insuranceExpiresOn'] as const) {
      const v = dto[k];
      if (v === undefined) continue;
      if (v) this.checkExpiryDate(v, k === 'licenseExpiresOn' ? 'Permis' : 'Assurance');
      p[k] = v || null;
    }
    if (dto.consent) p.consentAt = new Date();
    await this.profiles.save(p);
    if (dto.vehiclePlate !== undefined) await this.users.update(userId, { plate: normalizePlate(p.vehiclePlate) });
    if (dto.vehicleType) {
      await this.users.update(userId, { vehicleType: dto.vehicleType });
      await this.companies.update(p.companyId, { vehicles: [dto.vehicleType] });
    }
    // Photo de profil = selfie (pris en direct dans l'app), jamais une photo de la galerie
    if (dto.selfieUrl) await this.users.update(userId, { avatarUrl: dto.selfieUrl });
    return this.withLinks(p);
  }

  /** Envoi du dossier à LETO */
  async submit(userId: string) {
    const p = await this.mine(userId);
    if (p.status === IndependentStatus.PENDING) return this.withLinks(p);
    if (p.status !== IndependentStatus.DRAFT && p.status !== IndependentStatus.REJECTED) throw new BadRequestException('Dossier déjà traité');
    const missing = REQUIRED.filter(([k]) => !p[k]).map(([, label]) => label);
    if (missing.length) throw new BadRequestException(`Dossier incomplet : ${missing.join(', ')}`);
    if (!p.consentAt) throw new BadRequestException('Acceptez le traitement de vos données pour envoyer le dossier');
    const expired = this.expiredText(p);
    if (expired) throw new BadRequestException(expired.replace(/ : .*/, ' : prenez en photo le document en cours de validité'));
    p.status = IndependentStatus.PENDING;
    p.submittedAt = new Date();
    p.reviewNote = null;
    p.history = [...p.history, { at: p.submittedAt.toISOString(), action: 'SUBMITTED' }];
    await this.profiles.save(p);
    this.tracking.server?.to('super-admin').emit('independents:changed', { id: p.id });
    const who = await this.users.findOneBy({ id: p.userId });
    this.notify.office({ sa: true }, 'INDEPENDENT', {
      title: 'Dossier de livreur indépendant',
      body: `${who?.name ?? 'Un livreur'} a envoyé son dossier : à vérifier`,
      link: '/independants',
    });
    return this.withLinks(p);
  }

  // ---------- Super Admin ----------

  async list(status?: IndependentStatus) {
    const rows = await this.db.query(
      `SELECT p.id, p.status, p."vehicleType", p."vehiclePlate", p.commune, p."submittedAt", p."reviewedAt", p."reviewNote", p."createdAt",
              u.id AS "userId", u.name, u.phone, u.active, u."lastLocationAt",
              c.id AS "companyId", c.credit, p."affiliatedCompanyId", p."legacyUntil",
              p."licenseExpiresOn", p."insuranceExpiresOn", jsonb_array_length(p.renewals)::int AS renewals,
              (SELECT ac.name FROM companies ac WHERE ac.id = p."affiliatedCompanyId") AS "affiliatedCompanyName",
              (SELECT count(*)::int FROM deliveries d WHERE d."driverId" = u.id AND d.status = 'DELIVERED') AS completed
         FROM independent_profiles p
         JOIN users u ON u.id = p."userId"
         JOIN companies c ON c.id = p."companyId"
        WHERE ($1::text IS NULL OR p.status = $1)
        ORDER BY coalesce(p."submittedAt", p."createdAt") DESC
        LIMIT 1000`,
      [status ?? null],
    );
    const [counts] = await this.db.query(
      `SELECT count(*) FILTER (WHERE status = 'PENDING')::int AS pending,
              count(*) FILTER (WHERE status = 'APPROVED')::int AS approved,
              count(*) FILTER (WHERE status = 'REJECTED')::int AS rejected,
              count(*) FILTER (WHERE status = 'SUSPENDED')::int AS suspended,
              count(*) FILTER (WHERE status = 'DRAFT')::int AS draft,
              count(*) FILTER (WHERE jsonb_array_length(renewals) > 0)::int AS renewals,
              count(*) FILTER (WHERE status IN ('APPROVED', 'SUSPENDED') AND (${DOCS_VALID_SQL('independent_profiles')}) IS NOT TRUE)::int AS expired
         FROM independent_profiles`,
    );
    return { items: rows, counts, config: this.config };
  }

  async one(id: string) {
    const p = await this.profiles.findOne({ where: { id }, relations: { user: true } });
    if (!p) throw new NotFoundException('Dossier introuvable');
    return this.withLinks(p);
  }

  private async review(id: string, by: string, to: IndependentStatus, action: IndependentEvent['action'], allowed: IndependentStatus[], note?: string) {
    const p = await this.profiles.findOneBy({ id });
    if (!p) throw new NotFoundException('Dossier introuvable');
    if (!allowed.includes(p.status)) throw new BadRequestException('Action impossible pour ce dossier');
    p.status = to;
    p.reviewedAt = new Date();
    p.reviewedBy = by;
    p.reviewNote = note?.trim() || null;
    p.history = [...p.history, { at: p.reviewedAt.toISOString(), action, by, note: note?.trim() || undefined }];
    await this.profiles.save(p);
    this.tracking.emitToUser(p.userId, 'independent:status', { status: to, note: p.reviewNote });
    this.tracking.server?.to('super-admin').emit('independents:changed', { id });
    return this.one(id);
  }

  async approve(id: string, by: string) {
    const r = await this.review(id, by, IndependentStatus.APPROVED, 'APPROVED', [IndependentStatus.PENDING, IndependentStatus.REJECTED]);
    this.queuePoolNotice(id);
    return r;
  }
  reject(id: string, by: string, note: string) {
    if (!note?.trim()) throw new BadRequestException('Motif du refus obligatoire');
    return this.review(id, by, IndependentStatus.REJECTED, 'REJECTED', [IndependentStatus.PENDING], note);
  }
  suspend(id: string, by: string, note: string) {
    if (!note?.trim()) throw new BadRequestException('Motif de la suspension obligatoire');
    return this.review(id, by, IndependentStatus.SUSPENDED, 'SUSPENDED', [IndependentStatus.APPROVED], note);
  }
  reactivate(id: string, by: string) {
    return this.review(id, by, IndependentStatus.APPROVED, 'REACTIVATED', [IndependentStatus.SUSPENDED]);
  }

  // ---------- Documents : dates de validité, renouvellements ----------

  private checkExpiryDate(d: string, what: string) {
    if (!validDate(d)) throw new BadRequestException(`${what} : date de fin de validité invalide (AAAA-MM-JJ)`);
    if (d < today()) throw new BadRequestException(`${what} déjà expiré : prenez en photo le document en cours de validité`);
    if (d > today(366 * 15)) throw new BadRequestException(`${what} : date de fin de validité trop lointaine`);
  }

  /** Ajoute un événement à l'historique du dossier */
  async logEvent(profileId: string, e: Omit<IndependentEvent, 'at'>) {
    const event: IndependentEvent = { at: new Date().toISOString(), ...e };
    await this.db.query(`UPDATE independent_profiles SET history = history || $2::jsonb WHERE id = $1`, [profileId, JSON.stringify([event])]);
  }

  /** Le LI envoie un document renouvelé (nouvelle photo et/ou nouvelle date), validé ensuite par LETO */
  async submitRenewal(userId: string, dto: { field: RenewableField; url?: string; expiresOn?: string }) {
    const p = await this.mine(userId);
    if (p.status !== IndependentStatus.APPROVED && p.status !== IndependentStatus.SUSPENDED) {
      throw new BadRequestException('Dossier pas encore validé : modifiez-le directement dans l’app');
    }
    if (!RENEWABLE.includes(dto.field)) throw new BadRequestException('Document inconnu');
    const expiring = dto.field in EXPIRING;
    if (expiring) {
      if (!dto.expiresOn) throw new BadRequestException('Indiquez la date de fin de validité du document');
      this.checkExpiryDate(dto.expiresOn, dto.field === 'licenseUrl' ? 'Permis' : 'Assurance');
    }
    if (!dto.url && !(expiring && p[dto.field])) throw new BadRequestException('Prenez le document en photo');
    const r: Renewal = { id: randomUUID(), field: dto.field, url: dto.url ?? null, expiresOn: expiring ? dto.expiresOn! : null, at: new Date().toISOString() };
    p.renewals = [...(p.renewals ?? []).filter((x) => x.field !== dto.field), r];
    p.history = [...p.history, { at: r.at, action: 'RENEWAL_SENT', note: DOC_LABEL[dto.field] }];
    await this.profiles.save(p);
    this.tracking.server?.to('super-admin').emit('independents:changed', { id: p.id });
    const who = await this.users.findOneBy({ id: userId });
    this.notify.office({ sa: true }, 'INDEPENDENT', {
      title: 'Document renouvelé',
      body: `${who?.name ?? 'Un livreur indépendant'} a envoyé : ${DOC_LABEL[dto.field]}. À vérifier.`,
      link: '/independants',
    });
    return this.withLinks(p);
  }

  private docsChanged(p: IndependentProfile) {
    this.tracking.emitToUser(p.userId, 'independent:docs', {});
    this.tracking.emitToUser(p.userId, 'deliveries:changed', {});
    this.tracking.server?.to('super-admin').emit('independents:changed', { id: p.id });
    if (p.affiliatedCompanyId) this.tracking.emitToCompany(p.affiliatedCompanyId, 'affiliations:changed', {});
  }

  /** LETO valide un document renouvelé : il remplace l'ancien */
  async approveRenewal(id: string, renewalId: string, by: string) {
    const p = await this.profiles.findOneBy({ id });
    const r = p?.renewals?.find((x) => x.id === renewalId);
    if (!p || !r) throw new NotFoundException('Document introuvable ou déjà traité');
    if (r.url) p[r.field] = r.url;
    const dateKey = EXPIRING[r.field as keyof typeof EXPIRING];
    if (dateKey && r.expiresOn) {
      p[dateKey] = r.expiresOn;
      p.expiryNotices = (p.expiryNotices ?? []).filter((n) => !n.startsWith(`${r.field}:`));
    }
    p.renewals = p.renewals.filter((x) => x.id !== renewalId);
    p.updateRequests = (p.updateRequests ?? []).filter((x) => x.field !== r.field);
    p.history = [...p.history, { at: new Date().toISOString(), action: 'RENEWAL_APPROVED', by, note: `${DOC_LABEL[r.field]}${r.expiresOn ? ` · valable jusqu’au ${frDate(r.expiresOn)}` : ''}` }];
    await this.profiles.save(p);
    const unblocked = !this.expiredText(p);
    this.notify.send([p.userId], 'CLIENT_UPDATE', {
      title: 'Document validé',
      body: `LETO a validé votre ${DOC_LABEL[r.field]}.${unblocked ? '' : ' Un autre document reste à renouveler.'}`,
    });
    if (p.affiliatedCompanyId) {
      const who = await this.users.findOneBy({ id: p.userId });
      this.notify.office({ companyId: p.affiliatedCompanyId }, 'AFFILIATION', {
        title: 'Document renouvelé',
        body: `${who?.name ?? 'Votre livreur'} : ${DOC_LABEL[r.field]} à jour${r.expiresOn ? `, valable jusqu’au ${frDate(r.expiresOn)}` : ''}`,
        link: '/independants',
      });
    }
    this.docsChanged(p);
    return this.one(id);
  }

  async rejectRenewal(id: string, renewalId: string, by: string, note: string) {
    if (!note?.trim()) throw new BadRequestException('Motif du refus obligatoire');
    const p = await this.profiles.findOneBy({ id });
    const r = p?.renewals?.find((x) => x.id === renewalId);
    if (!p || !r) throw new NotFoundException('Document introuvable ou déjà traité');
    p.renewals = p.renewals.filter((x) => x.id !== renewalId);
    p.history = [...p.history, { at: new Date().toISOString(), action: 'RENEWAL_REJECTED', by, note: `${DOC_LABEL[r.field]} : ${note.trim()}` }];
    await this.profiles.save(p);
    this.notify.send([p.userId], 'UPDATED', { title: 'Document refusé', body: `${DOC_LABEL[r.field]} : « ${note.trim()} ». Renvoyez-le dans l’app, rubrique « Mes documents ».` });
    this.docsChanged(p);
    return this.one(id);
  }

  /** LETO corrige les dates de fin de validité (dossiers validés avant les dates, erreur de saisie) */
  async setExpiry(id: string, dto: { licenseExpiresOn?: string | null; insuranceExpiresOn?: string | null }, by: string) {
    const p = await this.profiles.findOneBy({ id });
    if (!p) throw new NotFoundException('Dossier introuvable');
    const notes: string[] = [];
    for (const [k, field, label] of [['licenseExpiresOn', 'licenseUrl', 'Permis'], ['insuranceExpiresOn', 'insuranceUrl', 'Assurance']] as const) {
      const v = dto[k];
      if (v === undefined || v === p[k]) continue;
      if (v && !validDate(v)) throw new BadRequestException(`${label} : date invalide (AAAA-MM-JJ)`);
      p[k] = v || null;
      p.expiryNotices = (p.expiryNotices ?? []).filter((n) => !n.startsWith(`${field}:`));
      notes.push(`${label} : ${v ? `jusqu’au ${frDate(v)}` : 'date retirée'}`);
    }
    if (!notes.length) return this.one(id);
    p.history = [...p.history, { at: new Date().toISOString(), action: 'EXPIRY_SET', by, note: notes.join(' · ') }];
    await this.profiles.save(p);
    this.docsChanged(p);
    await this.checkExpiries(p.id);
    return this.one(id);
  }

  /** Rappels (30 jours avant) et blocage (le lendemain de la date) du permis et de l'assurance */
  async checkExpiries(onlyId?: string) {
    const rows = await this.profiles
      .createQueryBuilder('p')
      .where(`p.status IN ('APPROVED', 'SUSPENDED')`)
      .andWhere(`(p."licenseExpiresOn" <= :warn OR p."insuranceExpiresOn" <= :warn)`, { warn: today(EXPIRY_WARN_DAYS) })
      .andWhere(onlyId ? 'p.id = :id' : '1 = 1', { id: onlyId })
      .getMany();
    for (const p of rows) {
      const sent = new Set(p.expiryNotices ?? []);
      const fresh: string[] = [];
      let expiredNow = false;
      for (const [field, dateKey] of Object.entries(EXPIRING) as [keyof typeof EXPIRING, 'licenseExpiresOn' | 'insuranceExpiresOn'][]) {
        const d = p[dateKey];
        const state = expiryState(d);
        if (state !== 'SOON' && state !== 'EXPIRED') continue;
        const key = `${field}:${d}:${state === 'EXPIRED' ? 'expired' : 'soon'}`;
        if (sent.has(key)) continue;
        // Un document qui expire déjà ne reçoit plus le rappel « bientôt »
        fresh.push(key, ...(state === 'EXPIRED' ? [`${field}:${d}:soon`] : []));
        if (state === 'EXPIRED') expiredNow = true;
        const doc = DOC_LABEL[field];
        const pending = p.renewals?.some((r) => r.field === field);
        const user = await this.users.findOneBy({ id: p.userId });
        if (state === 'SOON') {
          this.notify.send([p.userId], 'UPDATED', {
            title: `Votre ${doc} expire le ${frDate(d!)}`,
            body: pending ? 'Le nouveau document est en cours de vérification par LETO.' : 'Envoyez le nouveau document dans l’app, rubrique « Mes documents », pour continuer à recevoir des courses.',
          });
          if (p.affiliatedCompanyId) {
            this.notify.office({ companyId: p.affiliatedCompanyId }, 'AFFILIATION', {
              title: 'Document bientôt expiré',
              body: `${user?.name ?? 'Un livreur'} : ${doc} valable jusqu’au ${frDate(d!)}`,
              link: '/independants',
            });
          }
        } else {
          this.notify.send([p.userId], 'CANCELLED', {
            title: `Votre ${doc} a expiré`,
            body: 'Vous ne recevez plus de courses. Envoyez le nouveau document dans l’app, rubrique « Mes documents ».',
          });
          if (p.affiliatedCompanyId) {
            this.notify.office({ companyId: p.affiliatedCompanyId }, 'AFFILIATION', {
              title: 'Document expiré',
              body: `${user?.name ?? 'Un livreur'} : ${doc} expiré le ${frDate(d!)}. Il ne reçoit plus de courses jusqu’au renouvellement.`,
              link: '/independants',
            });
          }
          p.history = [...p.history, { at: new Date().toISOString(), action: 'EXPIRED', note: `${doc} · ${frDate(d!)}` }];
        }
      }
      if (!fresh.length) continue;
      p.expiryNotices = [...sent, ...fresh].slice(-40);
      await this.profiles.save(p);
      if (expiredNow) this.docsChanged(p);
    }
  }

  // ---------- Photos privées : liens signés et temporaires ----------

  private sign(name: string, exp: number) {
    return createHmac('sha256', process.env.JWT_SECRET ?? 'leto').update(`identity:${name}:${exp}`).digest('hex').slice(0, 32);
  }

  link(path: string | null) {
    if (!path) return null;
    if (path.startsWith('/uploads/')) return path; // selfie = photo de profil (publique)
    const name = path.replace(/^\/identity\//, '');
    const exp = Math.floor(Date.now() / 1000) + LINK_TTL_S;
    return `/identity/${name}?exp=${exp}&sig=${this.sign(name, exp)}`;
  }

  verify(name: string, exp: string, sig: string) {
    const e = Number(exp);
    if (!Number.isInteger(e) || e < Date.now() / 1000 || typeof sig !== 'string') return false;
    const a = Buffer.from(this.sign(name, e));
    const b = Buffer.from(sig);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  withLinks(p: IndependentProfile) {
    const links = Object.fromEntries(DOC_FIELDS.map((k) => [k, this.link(p[k])]));
    return {
      ...p,
      links,
      renewals: (p.renewals ?? []).map((r) => ({ ...r, link: this.link(r.url), label: DOC_LABEL[r.field] })),
      updateRequests: (p.updateRequests ?? []).map((r) => ({ ...r, label: DOC_LABEL[r.field] })),
      docs: docsState(p),
      required: REQUIRED.map(([k, label]) => ({ key: k, label, ok: !!p[k] })),
      config: { enabled: this.cfg.enabled },
    };
  }

  /** Engins valides (pour les contrôles) */
  static vehicles = Object.values(VehicleType) as string[];
}
