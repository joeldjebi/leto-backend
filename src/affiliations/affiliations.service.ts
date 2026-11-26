import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { BillingService } from '../billing/billing.service';
import { Company } from '../companies/company.entity';
import { money } from '../countries/phone';
import { randomUUID } from 'crypto';
import { DOC_FIELDS, DOC_LABEL, IndependentProfile, IndependentStatus, RENEWABLE, RenewableField } from '../independents/independent-profile.entity';
import { docsState, IndependentsService } from '../independents/independents.service';
import { NotifyService } from '../notifications/notify.service';
import { RemittancesService } from '../remittances/remittances.service';
import { TrackingGateway } from '../tracking/tracking.gateway';
import { AffiliationInvite, CompanyEarning, EarningType, InviteStatus, RuleType, Withdrawal, WithdrawalStatus } from './affiliation.entities';

/** Immatriculation partiellement masquée dans le vivier : « •••• AB 01 » */
const maskPlate = (plate: string | null) => {
  if (!plate) return null;
  let left = plate.replace(/\s/g, '').length - 4; // les 4 derniers caractères restent visibles
  return [...plate].map((ch) => (ch !== ' ' && left-- > 0 ? '•' : ch)).join('');
};

const ruleLabel = (type: RuleType | null, value: number | null) =>
  type == null || value == null ? null : type === 'PERCENT' ? `${value} %` : money(value);

/**
 * Rattachement des livreurs indépendants (LI) aux entreprises de livraison :
 * vivier des LI validés, invitations acceptées par le LI, commission de l'entreprise,
 * gains gardés par LETO (retrait ou transfert vers le crédit).
 */
@Injectable()
export class AffiliationsService {
  constructor(
    private db: DataSource,
    @InjectRepository(AffiliationInvite) private invites: Repository<AffiliationInvite>,
    @InjectRepository(CompanyEarning) private earnings: Repository<CompanyEarning>,
    @InjectRepository(Withdrawal) private withdrawals: Repository<Withdrawal>,
    @InjectRepository(IndependentProfile) private profiles: Repository<IndependentProfile>,
    @InjectRepository(Company) private companies: Repository<Company>,
    private independents: IndependentsService,
    private billing: BillingService,
    private tracking: TrackingGateway,
    private push: NotifyService,
    private remittances: RemittancesService,
  ) {}

  private caps() {
    const c = this.independents.config;
    return { maxPct: c.companyMaxPct, maxFixed: c.companyMaxFixed };
  }

  private changed(companyId: string | null, userId?: string | null) {
    if (companyId) this.tracking.emitToCompany(companyId, 'affiliations:changed', {});
    if (userId) this.tracking.emitToUser(userId, 'affiliation:changed', {});
  }

  // ---------- Entreprise ----------

  /** Vivier des LI validés libres, mes LI, mes invitations, mon taux */
  async forCompany(companyId: string) {
    const company = await this.companies.findOneBy({ id: companyId });
    if (!company || company.independent) throw new ForbiddenException('Réservé aux entreprises de livraison');
    const pool = await this.db.query(
      `SELECT p.id, u.name, p."selfieUrl", p.commune, p."vehicleType", p."vehicleBrand", p."vehiclePlate", p."legacyUntil", p."reviewedAt",
              (p."reviewedAt" > coalesce($2::timestamptz, now() - interval '7 days')) AS "isNew",
              p."idFrontUrl", p."idBackUrl", p."licenseUrl", p."registrationUrl", p."insuranceUrl", p."licenseExpiresOn", p."insuranceExpiresOn",
              u."ratingAvg", u."ratingCount", (u."lastLocationAt" > now() - interval '2 minutes') AS online,
              (SELECT count(*)::int FROM deliveries d WHERE d."driverId" = u.id AND d.status = 'DELIVERED') AS completed,
              (SELECT i.id FROM affiliation_invites i WHERE i."profileId" = p.id AND i."companyId" = $1 AND i.status = 'PENDING' AND i.kind = 'JOIN' LIMIT 1) AS "inviteId"
         FROM independent_profiles p JOIN users u ON u.id = p."userId"
        WHERE p.status = 'APPROVED' AND p."affiliatedCompanyId" IS NULL AND u.active
        ORDER BY online DESC, completed DESC
        LIMIT 500`,
      [companyId, company.liPoolSeenAt],
    );
    const mine = await this.db.query(
      `SELECT p.id, u.id AS "userId", u.name, u.phone, p."selfieUrl", p.commune, p."vehicleType", p."vehiclePlate",
              p."licenseExpiresOn", p."insuranceExpiresOn", jsonb_array_length(p.renewals)::int AS renewals,
              (SELECT count(*)::int FROM jsonb_array_elements(p."updateRequests") r WHERE (r->>'companyId')::uuid = $1) AS "updateRequests",
              p."affiliatedAt", p."affCommissionType", p."affCommissionValue", c.credit,
              u."ratingAvg", u."ratingCount", (u."lastLocationAt" > now() - interval '2 minutes') AS online,
              (SELECT count(*)::int FROM deliveries d WHERE d."driverId" = u.id AND d.status = 'DELIVERED' AND d."affiliateCompanyId" = $1) AS completed,
              (SELECT count(*)::int FROM deliveries d WHERE d."driverId" = u.id AND d.status IN ('ACCEPTED', 'PICKED_UP')) AS active,
              (SELECT coalesce(sum(e.amount), 0)::int FROM company_earnings e WHERE e."companyId" = $1 AND e."driverId" = u.id AND e.type IN ('COMMISSION', 'REVERSAL')) AS earned,
              (SELECT i."commissionType" || ':' || i."commissionValue" FROM affiliation_invites i WHERE i."profileId" = p.id AND i."companyId" = $1 AND i.status = 'PENDING' AND i.kind = 'RATE' LIMIT 1) AS "pendingRate"
         FROM independent_profiles p JOIN users u ON u.id = p."userId" JOIN companies c ON c.id = p."companyId"
        WHERE p."affiliatedCompanyId" = $1
        ORDER BY p."affiliatedAt" DESC`,
      [companyId],
    );
    const sent = await this.db.query(
      `SELECT i.id, i.kind, i."commissionType", i."commissionValue", i."createdAt", i."profileId", u.name
         FROM affiliation_invites i JOIN independent_profiles p ON p.id = i."profileId" JOIN users u ON u.id = p."userId"
        WHERE i."companyId" = $1 AND i.status = 'PENDING' AND i.kind = 'JOIN'
        ORDER BY i."createdAt" DESC`,
      [companyId],
    );
    // Encaissements (paiement à la livraison) que chaque LI doit verser à l'entreprise
    const cash = new Map((await this.remittances.balances(companyId)).filter((b) => b.independent).map((b) => [b.driverId, b]));
    return {
      codAllowed: company.liCodAllowed,
      rate: company.liCommissionType ? { type: company.liCommissionType, value: company.liCommissionValue } : null,
      caps: this.caps(),
      pool: pool.map((r: any) => {
        const docs = docsState(r);
        return {
          id: r.id, name: r.name, selfieUrl: r.selfieUrl, commune: r.commune, vehicleType: r.vehicleType, vehicleBrand: r.vehicleBrand,
          plate: maskPlate(r.vehiclePlate), legacyUntil: r.legacyUntil, reviewedAt: r.reviewedAt,
          ratingAvg: r.ratingAvg, ratingCount: r.ratingCount, online: r.online, completed: r.completed, inviteId: r.inviteId, isNew: r.isNew,
          // Vérifié par LETO à la validation du dossier ; le permis et l'assurance avec leur validité
          verified: {
            identity: !!(r.idFrontUrl && r.idBackUrl),
            license: r.licenseUrl ? docs.license.state : null,
            registration: !!r.registrationUrl,
            insurance: r.insuranceUrl ? docs.insurance.state : null,
          },
        };
      }),
      mine: mine.map((r: any) => ({
        ...r,
        docs: docsState(r),
        cod: cash.get(r.userId)?.cod ?? 0,
        codToRemit: cash.get(r.userId)?.toRemit ?? 0,
        codPending: cash.get(r.userId)?.pending ?? 0,
        appliedRate: r.affCommissionType ? this.independents.capRule(r.affCommissionType, Number(r.affCommissionValue)) : null,
      })),
      invites: sent,
    };
  }

  /** Nouveaux livreurs du vivier depuis la dernière visite (7 derniers jours à la première visite) */
  async poolNews(companyId: string) {
    const company = await this.companies.findOneBy({ id: companyId });
    if (!company || company.independent) return { count: 0, names: [] };
    const rows: { name: string }[] = await this.db.query(
      `SELECT u.name FROM independent_profiles p JOIN users u ON u.id = p."userId"
        WHERE p.status = 'APPROVED' AND p."affiliatedCompanyId" IS NULL AND u.active
          AND p."reviewedAt" > coalesce($1::timestamptz, now() - interval '7 days')
        ORDER BY p."reviewedAt" DESC`,
      [company.liPoolSeenAt],
    );
    return { count: rows.length, names: rows.slice(0, 3).map((r) => r.name) };
  }

  /** Vivier consulté : le bandeau disparaît pour tous les gérants de l'entreprise */
  async poolSeen(companyId: string) {
    await this.companies.update(companyId, { liPoolSeenAt: new Date() });
    this.tracking.emitToCompany(companyId, 'affiliations:changed', { poolSeen: true });
    return { count: 0, names: [] };
  }

  /** L'entreprise fixe sa commission sur ses LI ; les LI déjà rattachés doivent accepter le nouveau taux */
  async setRate(companyId: string, type: RuleType, value: number, by: string) {
    const { maxPct, maxFixed } = this.caps();
    if (type !== 'PERCENT' && type !== 'FIXED') throw new BadRequestException('Commission : pourcentage ou montant fixe');
    if (!Number.isFinite(value) || value < 0) throw new BadRequestException('Commission invalide');
    if (type === 'PERCENT' && value > maxPct) throw new BadRequestException(`Commission maximum autorisée par LETO : ${maxPct} %`);
    if (type === 'FIXED' && (value > maxFixed || !Number.isInteger(value))) throw new BadRequestException(`Commission fixe : nombre entier, ${money(maxFixed)} maximum`);
    const v = type === 'PERCENT' ? Math.round(value * 100) / 100 : value;
    await this.companies.update(companyId, { liCommissionType: type, liCommissionValue: v });
    // Invitations en attente : nouveau taux ; LI rattachés : à faire accepter
    await this.invites.update({ companyId, status: InviteStatus.PENDING, kind: 'JOIN' }, { commissionType: type, commissionValue: v });
    await this.invites.update({ companyId, status: InviteStatus.PENDING, kind: 'RATE' }, { status: InviteStatus.CANCELLED, respondedAt: new Date() });
    const linked = await this.profiles.find({ where: { affiliatedCompanyId: companyId } });
    const company = await this.companies.findOneBy({ id: companyId });
    for (const p of linked) {
      if (p.affCommissionType === type && Number(p.affCommissionValue) === v) continue;
      await this.invites.save({ profileId: p.id, companyId, kind: 'RATE', commissionType: type, commissionValue: v, createdBy: by });
      this.push.send([p.userId], 'UPDATED', {
        title: 'Nouvelle commission de votre entreprise',
        body: `${company?.name ?? 'Votre entreprise'} propose ${ruleLabel(type, v)} par course. Acceptez ou refusez dans l’app.`,
      });
      this.changed(null, p.userId);
    }
    this.changed(companyId);
    return this.forCompany(companyId);
  }

  /** L'entreprise autorise (ou non) ses LI à prendre les courses avec paiement à la livraison */
  async setCod(companyId: string, allowed: boolean) {
    await this.companies.update(companyId, { liCodAllowed: allowed });
    const company = await this.companies.findOneBy({ id: companyId });
    const linked = await this.profiles.find({ where: { affiliatedCompanyId: companyId } });
    for (const p of linked) {
      this.push.send([p.userId], 'UPDATED', {
        title: allowed ? 'Paiement à la livraison autorisé' : 'Paiement à la livraison retiré',
        body: allowed
          ? `${company?.name ?? 'Votre entreprise'} vous autorise à prendre les courses avec paiement à la livraison. Versez-lui les montants encaissés.`
          : `${company?.name ?? 'Votre entreprise'} ne vous autorise plus à prendre de nouvelles courses avec paiement à la livraison.`,
      });
      this.tracking.emitToUser(p.userId, 'deliveries:changed', {});
      this.changed(null, p.userId);
    }
    this.changed(companyId);
    return this.forCompany(companyId);
  }

  /** Invitation d'un LI du vivier */
  async invite(companyId: string, profileId: string, message: string | undefined, by: string) {
    const company = await this.companies.findOneBy({ id: companyId });
    if (!company?.liCommissionType || company.liCommissionValue == null) throw new BadRequestException('Fixez d’abord votre commission sur les livreurs indépendants');
    if (!company.active || company.status !== 'APPROVED') throw new ForbiddenException('Entreprise non active');
    const p = await this.profiles.findOneBy({ id: profileId });
    if (!p || p.status !== IndependentStatus.APPROVED) throw new NotFoundException('Livreur introuvable');
    if (p.affiliatedCompanyId) throw new ConflictException('Ce livreur est déjà rattaché à une entreprise');
    if (await this.invites.existsBy({ profileId, companyId, status: InviteStatus.PENDING, kind: 'JOIN' })) throw new ConflictException('Invitation déjà envoyée');
    await this.invites.save({
      profileId,
      companyId,
      kind: 'JOIN',
      commissionType: company.liCommissionType,
      commissionValue: company.liCommissionValue,
      message: message?.trim() || null,
      createdBy: by,
    });
    this.push.send([p.userId], 'ASSIGNED', {
      title: `${company.name} vous invite`,
      body: `Rejoignez cette entreprise de livraison (commission ${ruleLabel(company.liCommissionType, company.liCommissionValue)} par course). Répondez dans l’app.`,
    });
    this.changed(companyId, p.userId);
    return this.forCompany(companyId);
  }

  async cancelInvite(companyId: string, id: string) {
    const inv = await this.invites.findOneBy({ id, companyId });
    if (!inv || inv.status !== InviteStatus.PENDING) throw new BadRequestException('Invitation introuvable ou déjà traitée');
    await this.invites.update(id, { status: InviteStatus.CANCELLED, respondedAt: new Date() });
    const p = await this.profiles.findOneBy({ id: inv.profileId });
    this.changed(companyId, p?.userId);
    return this.forCompany(companyId);
  }

  /** Fin du rattachement (par l'entreprise ou par le LI), impossible pendant une course */
  async end(profileId: string, by: { companyId?: string; userId?: string; name: string }, reason?: string) {
    const p = await this.profiles.findOneBy({ id: profileId });
    if (!p?.affiliatedCompanyId) throw new BadRequestException('Ce livreur n’est rattaché à aucune entreprise');
    if (by.companyId && p.affiliatedCompanyId !== by.companyId) throw new NotFoundException('Livreur introuvable');
    if (by.userId && p.userId !== by.userId) throw new ForbiddenException();
    const [{ n }] = await this.db.query(`SELECT count(*)::int AS n FROM deliveries WHERE "driverId" = $1 AND status IN ('ACCEPTED', 'PICKED_UP')`, [p.userId]);
    if (n > 0) throw new BadRequestException('Course en cours : terminez-la avant de mettre fin au rattachement');
    const companyId = p.affiliatedCompanyId;
    // Encaissements pas encore versés à l'entreprise : à régler avant
    const [owed] = await this.remittances.balances(companyId, p.userId);
    if (owed && owed.toRemit > 0) {
      throw new BadRequestException(
        `${money(owed.toRemit)} encaissés à la livraison restent à verser à l’entreprise${owed.pending ? ` (dont ${money(owed.pending)} en attente de confirmation)` : ''} : réglez-les avant de mettre fin au rattachement`,
      );
    }
    const company = await this.companies.findOneBy({ id: companyId });
    await this.profiles.update(p.id, {
      affiliatedCompanyId: null,
      affiliatedAt: null,
      affCommissionType: null,
      affCommissionValue: null,
      updateRequests: (p.updateRequests ?? []).filter((r) => r.companyId !== companyId),
    });
    await this.independents.logEvent(p.id, { action: 'UNAFFILIATED', by: by.companyId ? company?.name : by.name, note: `Fin du partage du dossier avec ${company?.name ?? 'l’entreprise'}${reason?.trim() ? ` · ${reason.trim()}` : ''}` });
    await this.invites.update({ profileId: p.id, status: InviteStatus.PENDING, kind: 'RATE' }, { status: InviteStatus.CANCELLED, respondedAt: new Date() });
    const why = reason?.trim() ? ` : « ${reason.trim()} »` : '';
    if (by.companyId) {
      this.push.send([p.userId], 'UPDATED', { title: 'Rattachement terminé', body: `${company?.name ?? 'Votre entreprise'} a mis fin à votre rattachement${why}. Acceptez une autre invitation pour continuer.` });
    } else {
      this.push.office({ companyId }, 'AFFILIATION', { title: 'Un livreur indépendant vous quitte', body: `${by.name} n’est plus rattaché à votre entreprise${why}`, link: '/independants' });
    }
    this.changed(companyId, p.userId);
    return { ok: true };
  }

  /** Dossier complet d'un LI rattaché (partagé à l'acceptation de l'invitation) ; chaque consultation est notée */
  async dossier(companyId: string, profileId: string, viewer?: string) {
    const p = await this.profiles.findOne({ where: { id: profileId }, relations: { user: true } });
    if (!p || p.affiliatedCompanyId !== companyId) throw new NotFoundException('Dossier visible uniquement pour vos livreurs rattachés');
    const company = await this.companies.findOneBy({ id: companyId });
    if (viewer) {
      // Une trace par entreprise et par heure suffit
      const last = [...p.history].reverse().find((h) => h.action === 'VIEWED' && h.by === company?.name);
      if (!last || Date.now() - new Date(last.at).getTime() > 3_600_000) {
        await this.independents.logEvent(p.id, { action: 'VIEWED', by: company?.name, note: `Dossier consulté par ${viewer}` });
      }
    }
    const full = this.independents.withLinks(p);
    return {
      id: p.id,
      name: p.user.name,
      phone: p.user.phone,
      avatarUrl: p.user.avatarUrl ?? p.selfieUrl,
      birthDate: p.birthDate,
      commune: p.commune,
      address: p.address,
      idType: p.idType,
      idNumber: p.idNumber,
      emergencyName: p.emergencyName,
      emergencyPhone: p.emergencyPhone,
      vehicleType: p.vehicleType,
      vehicleBrand: p.vehicleBrand,
      vehiclePlate: p.vehiclePlate,
      licenseNumber: p.licenseNumber,
      approvedAt: p.reviewedAt,
      affiliatedAt: p.affiliatedAt,
      links: Object.fromEntries(DOC_FIELDS.map((k) => [k, full.links[k]])),
      docs: full.docs,
      // Renouvellements en attente : l'entreprise voit lesquels, LETO les vérifie
      renewals: full.renewals.map((r) => ({ field: r.field, label: r.label, expiresOn: r.expiresOn, at: r.at })),
      updateRequests: full.updateRequests.filter((r) => r.companyId === companyId),
      views: p.history.filter((h) => h.action === 'VIEWED' || h.action === 'AFFILIATED' || h.action === 'UPDATE_REQUESTED' || h.action.startsWith('RENEWAL') || h.action === 'EXPIRED').slice(-20).reverse(),
    };
  }

  /** L'entreprise demande au LI de renvoyer un document (flou, dépassé…) */
  async requestUpdate(companyId: string, profileId: string, field: RenewableField, note: string | undefined, by: string) {
    if (!RENEWABLE.includes(field)) throw new BadRequestException('Document inconnu');
    const p = await this.profiles.findOneBy({ id: profileId });
    if (!p || p.affiliatedCompanyId !== companyId) throw new NotFoundException('Livreur introuvable');
    const company = await this.companies.findOneBy({ id: companyId });
    const req = { id: randomUUID(), field, note: note?.trim() || null, companyId, by, at: new Date().toISOString() };
    await this.profiles.update(p.id, { updateRequests: [...(p.updateRequests ?? []).filter((r) => r.field !== field), req] });
    await this.independents.logEvent(p.id, { action: 'UPDATE_REQUESTED', by: company?.name, note: `${DOC_LABEL[field]}${req.note ? ` · ${req.note}` : ''}` });
    this.push.send([p.userId], 'UPDATED', {
      title: 'Document à mettre à jour',
      body: `${company?.name ?? 'Votre entreprise'} vous demande de renvoyer : ${DOC_LABEL[field]}${req.note ? ` (« ${req.note} »)` : ''}. Rubrique « Mes documents ».`,
    });
    this.tracking.emitToUser(p.userId, 'independent:docs', {});
    this.changed(companyId);
    return this.dossier(companyId, profileId);
  }

  // ---------- Livreur indépendant ----------

  private async myProfile(userId: string) {
    const p = await this.profiles.findOneBy({ userId });
    if (!p) throw new ForbiddenException('Réservé aux livreurs indépendants');
    return p;
  }

  /** Rattachement actuel, invitations reçues, fin de la transition */
  async forDriver(userId: string) {
    const p = await this.myProfile(userId);
    const company = p.affiliatedCompanyId ? await this.companies.findOneBy({ id: p.affiliatedCompanyId }) : null;
    const pending = await this.db.query(
      `SELECT i.id, i.kind, i."commissionType", i."commissionValue", i.message, i."createdAt", c.name AS "companyName", c.phone AS "companyPhone",
              (SELECT count(*)::int FROM users u WHERE u."companyId" = c.id AND u.role = 'DRIVER' AND u.active) AS drivers
         FROM affiliation_invites i JOIN companies c ON c.id = i."companyId"
        WHERE i."profileId" = $1 AND i.status = 'PENDING' AND c.active
        ORDER BY i."createdAt" DESC`,
      [p.id],
    );
    return {
      status: p.status,
      affiliation: company
        ? {
            companyId: company.id,
            companyName: company.name,
            companyPhone: company.phone,
            since: p.affiliatedAt,
            rateType: p.affCommissionType,
            rateValue: p.affCommissionValue == null ? null : this.independents.capRule(p.affCommissionType!, Number(p.affCommissionValue)),
            codAllowed: company.liCodAllowed,
          }
        : null,
      invites: pending,
      legacyUntil: p.affiliatedCompanyId ? null : p.legacyUntil,
      platformRate: { type: this.independents.config.commissionType, value: this.independents.config.commissionValue },
    };
  }

  /** Le LI accepte une invitation (rattachement) ou un nouveau taux */
  async accept(userId: string, inviteId: string) {
    const p = await this.myProfile(userId);
    const inv = await this.invites.findOneBy({ id: inviteId, profileId: p.id });
    if (!inv || inv.status !== InviteStatus.PENDING) throw new BadRequestException('Invitation introuvable ou expirée');
    const company = await this.companies.findOneBy({ id: inv.companyId });
    if (!company?.active) throw new BadRequestException('Cette entreprise n’est plus active');
    await this.db.transaction(async (m: EntityManager) => {
      if (inv.kind === 'JOIN') {
        if (p.status !== IndependentStatus.APPROVED) throw new BadRequestException('Votre dossier doit être validé par LETO');
        const fresh = await m.findOneBy(IndependentProfile, { id: p.id });
        if (fresh?.affiliatedCompanyId) throw new ConflictException('Vous êtes déjà rattaché : quittez d’abord votre entreprise');
        await m.update(IndependentProfile, p.id, {
          affiliatedCompanyId: inv.companyId,
          affiliatedAt: new Date(),
          affCommissionType: inv.commissionType,
          affCommissionValue: inv.commissionValue,
        });
        // Les autres invitations deviennent sans objet
        await m
          .createQueryBuilder()
          .update(AffiliationInvite)
          .set({ status: InviteStatus.CANCELLED, respondedAt: new Date() })
          .where('"profileId" = :pid AND status = :s AND id <> :id', { pid: p.id, s: InviteStatus.PENDING, id: inv.id })
          .execute();
      } else {
        if (p.affiliatedCompanyId !== inv.companyId) throw new BadRequestException('Vous n’êtes plus rattaché à cette entreprise');
        await m.update(IndependentProfile, p.id, { affCommissionType: inv.commissionType, affCommissionValue: inv.commissionValue });
      }
      await m.update(AffiliationInvite, inv.id, { status: InviteStatus.ACCEPTED, respondedAt: new Date() });
    });
    const [{ name }] = await this.db.query(`SELECT name FROM users WHERE id = $1`, [userId]);
    if (inv.kind === 'JOIN') {
      await this.independents.logEvent(p.id, { action: 'AFFILIATED', by: company.name, note: 'Dossier complet partagé avec l’entreprise (accord du livreur)' });
    }
    this.push.office({ companyId: inv.companyId }, 'AFFILIATION', {
      title: inv.kind === 'JOIN' ? 'Nouveau livreur indépendant' : 'Nouvelle commission acceptée',
      body: inv.kind === 'JOIN' ? `${name} a accepté de rejoindre votre entreprise` : `${name} accepte ${ruleLabel(inv.commissionType, inv.commissionValue)} par course`,
      link: '/independants',
    });
    this.changed(inv.companyId, userId);
    this.tracking.emitToUser(userId, 'deliveries:changed', {});
    return this.forDriver(userId);
  }

  async decline(userId: string, inviteId: string) {
    const p = await this.myProfile(userId);
    const inv = await this.invites.findOneBy({ id: inviteId, profileId: p.id });
    if (!inv || inv.status !== InviteStatus.PENDING) throw new BadRequestException('Invitation introuvable ou expirée');
    await this.invites.update(inv.id, { status: InviteStatus.DECLINED, respondedAt: new Date() });
    const [{ name }] = await this.db.query(`SELECT name FROM users WHERE id = $1`, [userId]);
    this.push.office({ companyId: inv.companyId }, 'AFFILIATION', {
      title: inv.kind === 'JOIN' ? 'Invitation refusée' : 'Nouvelle commission refusée',
      body: inv.kind === 'JOIN' ? `${name} a refusé votre invitation` : `${name} garde l’ancien taux. Vous pouvez mettre fin au rattachement.`,
      link: '/independants',
    });
    this.changed(inv.companyId, userId);
    return this.forDriver(userId);
  }

  async leave(userId: string, reason?: string) {
    const p = await this.myProfile(userId);
    const [{ name }] = await this.db.query(`SELECT name FROM users WHERE id = $1`, [userId]);
    await this.end(p.id, { userId, name }, reason);
    return this.forDriver(userId);
  }

  // ---------- Gains de l'entreprise ----------

  private async balance(m: EntityManager | DataSource, companyId: string) {
    const [r] = await m.query(
      `SELECT coalesce(sum(amount) FILTER (WHERE "availableAt" <= now()), 0)::int AS available,
              coalesce(sum(amount) FILTER (WHERE "availableAt" > now()), 0)::int AS pending,
              coalesce(sum(amount) FILTER (WHERE type IN ('COMMISSION', 'REVERSAL')), 0)::int AS earned
         FROM company_earnings WHERE "companyId" = $1`,
      [companyId],
    );
    return r as { available: number; pending: number; earned: number };
  }

  async earningsOf(companyId: string) {
    const [bal, ledger, withdrawals] = await Promise.all([
      this.balance(this.db, companyId),
      this.db.query(
        `SELECT e.*, u.name AS "driverName" FROM company_earnings e LEFT JOIN users u ON u.id = e."driverId"
          WHERE e."companyId" = $1 ORDER BY e."createdAt" DESC LIMIT 200`,
        [companyId],
      ),
      this.withdrawals.find({ where: { companyId }, order: { createdAt: 'DESC' }, take: 50 }),
    ]);
    const cfg = this.independents.config;
    return { ...bal, ledger, withdrawals, minWithdrawal: cfg.minWithdrawal, holdHours: cfg.earningsHoldHours };
  }

  /** Verrou sur l'entreprise : deux demandes simultanées ne peuvent pas dépasser le solde */
  private async lockAvailable(m: EntityManager, companyId: string, amount: number) {
    await m.getRepository(Company).createQueryBuilder('c').setLock('pessimistic_write').where('c.id = :id', { id: companyId }).getOne();
    const { available } = await this.balance(m, companyId);
    if (!Number.isInteger(amount) || amount <= 0) throw new BadRequestException('Montant invalide');
    if (amount > available) throw new BadRequestException(`Solde disponible insuffisant (${money(available)})`);
  }

  async requestWithdrawal(companyId: string, dto: { amount: number; operator: string; phone: string }, by: string) {
    const min = this.independents.config.minWithdrawal;
    if (dto.amount < min) throw new BadRequestException(`Retrait minimum : ${money(min)}`);
    const w = await this.db.transaction(async (m) => {
      await this.lockAvailable(m, companyId, dto.amount);
      const saved = await m.save(Withdrawal, { companyId, amount: dto.amount, operator: dto.operator.trim(), phone: dto.phone, requestedBy: by });
      await m.save(CompanyEarning, {
        companyId,
        type: EarningType.WITHDRAWAL,
        amount: -dto.amount,
        availableAt: new Date(),
        withdrawalId: saved.id,
        note: `Retrait ${dto.operator.trim()}`,
        createdBy: by,
      });
      return saved;
    });
    const company = await this.companies.findOneBy({ id: companyId });
    this.push.office({ sa: true }, 'WITHDRAWAL', {
      title: 'Demande de retrait',
      body: `${company?.name ?? 'Une entreprise'} demande ${money(w.amount)} (${w.operator})`,
      link: '/retraits',
    });
    this.tracking.server?.to('super-admin').emit('withdrawals:changed', {});
    this.changed(companyId);
    return this.earningsOf(companyId);
  }

  async transferToCredit(companyId: string, amount: number, by: string) {
    await this.db.transaction(async (m) => {
      await this.lockAvailable(m, companyId, amount);
      await m.save(CompanyEarning, { companyId, type: EarningType.TRANSFER, amount: -amount, availableAt: new Date(), note: 'Transfert vers le crédit', createdBy: by });
      await this.billing.creditFromEarnings(m, companyId, amount, by);
    });
    this.changed(companyId);
    return this.earningsOf(companyId);
  }

  // ---------- Super Admin : retraits ----------

  async listWithdrawals(status?: WithdrawalStatus) {
    return this.db.query(
      `SELECT w.*, c.name AS "companyName", c.phone AS "companyPhone" FROM company_withdrawals w JOIN companies c ON c.id = w."companyId"
        WHERE ($1::text IS NULL OR w.status = $1) ORDER BY w."createdAt" DESC LIMIT 500`,
      [status ?? null],
    );
  }

  async payWithdrawal(id: string, dto: { proofUrl?: string; reference?: string }, by: string) {
    const w = await this.withdrawals.findOneBy({ id });
    if (!w || w.status !== WithdrawalStatus.PENDING) throw new BadRequestException('Retrait introuvable ou déjà traité');
    await this.withdrawals.update(id, { status: WithdrawalStatus.PAID, proofUrl: dto.proofUrl ?? null, reference: dto.reference?.trim() || null, processedBy: by, processedAt: new Date() });
    this.push.office({ companyId: w.companyId }, 'WITHDRAWAL', { title: 'Retrait payé', body: `${money(w.amount)} envoyés sur ${w.operator} (${w.phone})`, link: '/independants' });
    this.changed(w.companyId);
    return this.listWithdrawals();
  }

  async rejectWithdrawal(id: string, note: string, by: string) {
    if (!note?.trim()) throw new BadRequestException('Motif obligatoire');
    await this.db.transaction(async (m) => {
      const w = await m.findOneBy(Withdrawal, { id });
      if (!w || w.status !== WithdrawalStatus.PENDING) throw new BadRequestException('Retrait introuvable ou déjà traité');
      await m.update(Withdrawal, id, { status: WithdrawalStatus.REJECTED, note: note.trim(), processedBy: by, processedAt: new Date() });
      await m.save(CompanyEarning, { companyId: w.companyId, type: EarningType.WITHDRAWAL_CANCELLED, amount: w.amount, availableAt: new Date(), withdrawalId: id, note: `Retrait refusé : ${note.trim()}`, createdBy: by });
      this.push.office({ companyId: w.companyId }, 'WITHDRAWAL', { title: 'Retrait refusé', body: `${money(w.amount)} rendus à votre solde : ${note.trim()}`, link: '/independants' });
      this.changed(w.companyId);
    });
    return this.listWithdrawals();
  }
}
