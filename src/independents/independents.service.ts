import { NotifyService } from '../notifications/notify.service';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { createHmac, timingSafeEqual } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { Company } from '../companies/company.entity';
import { VehicleType } from '../pricing/pricing';
import { Setting } from '../settings/setting.entity';
import { TrackingGateway } from '../tracking/tracking.gateway';
import { Role, User } from '../users/user.entity';
import { DOC_FIELDS, IndependentEvent, IndependentProfile, IndependentStatus } from './independent-profile.entity';

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
}

const KEY = 'independents';
const DEFAULT: IndependentsConfig = { registrationOpen: false, enabled: true, commissionType: 'PERCENT', commissionValue: 15 };
/** Durée des liens de lecture des pièces d'identité */
const LINK_TTL_S = 15 * 60;

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
];

/**
 * Livreurs indépendants (LI) : inscription dans l'app, dossier (identité, engin, photos),
 * validation par LETO, règles et commission propres.
 */
@Injectable()
export class IndependentsService implements OnModuleInit {
  private cfg: IndependentsConfig = { ...DEFAULT };

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
  }

  // ---------- Règles ----------

  get config(): IndependentsConfig {
    return { ...this.cfg };
  }

  async updateConfig(input: Partial<IndependentsConfig>, by: string) {
    const next = { ...this.cfg };
    if (input.registrationOpen !== undefined) next.registrationOpen = !!input.registrationOpen;
    if (input.enabled !== undefined) next.enabled = !!input.enabled;
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
  async blocker(companyId: string): Promise<string | null> {
    if (!this.cfg.enabled) return 'Les livreurs indépendants sont désactivés par LETO pour le moment';
    const p = await this.profiles.findOneBy({ companyId });
    switch (p?.status) {
      case IndependentStatus.APPROVED:
        return null;
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
    if (dto.consent) p.consentAt = new Date();
    await this.profiles.save(p);
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
              c.id AS "companyId", c.credit,
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
              count(*) FILTER (WHERE status = 'DRAFT')::int AS draft
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

  approve(id: string, by: string) {
    return this.review(id, by, IndependentStatus.APPROVED, 'APPROVED', [IndependentStatus.PENDING, IndependentStatus.REJECTED]);
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

  private withLinks(p: IndependentProfile) {
    const links = Object.fromEntries(DOC_FIELDS.map((k) => [k, this.link(p[k])]));
    return { ...p, links, required: REQUIRED.map(([k, label]) => ({ key: k, label, ok: !!p[k] })), config: { enabled: this.cfg.enabled } };
  }

  /** Engins valides (pour les contrôles) */
  static vehicles = Object.values(VehicleType) as string[];
}
