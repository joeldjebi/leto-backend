import { NotifyService } from '../notifications/notify.service';
import { money } from '../countries/phone';
import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { Company } from '../companies/company.entity';
import { Delivery, DeliveryStatus } from '../deliveries/delivery.entity';
import { IndependentsService } from '../independents/independents.service';
import { Setting } from '../settings/setting.entity';
import { TrackingGateway } from '../tracking/tracking.gateway';
import { CompanyEarning, EarningType } from '../affiliations/affiliation.entities';
import { CreditTransaction, CreditType, Payment, PaymentKind, PaymentStatus } from './billing.entities';

export type CommissionType = 'PERCENT' | 'FIXED';

export interface MobileMoneyAccount {
  operator: string;
  number: string;
  name: string;
}

/** Règles de facturation des entreprises, fixées par le SA */
export interface BillingConfig {
  subscriptionFee: number; // abonnement annuel (FCFA)
  commissionType: CommissionType; // règle par défaut
  commissionValue: number; // % ou FCFA
  accounts: MobileMoneyAccount[]; // comptes LETO où les entreprises paient
  subscriptionEnabled: boolean; // abonnement annuel exigé des entreprises
  trialDays: number; // essai gratuit des nouvelles entreprises (0 = pas d'essai)
}

const KEY = 'billing';
const DEFAULT: BillingConfig = { subscriptionFee: 100_000, commissionType: 'PERCENT', commissionValue: 10, accounts: [], subscriptionEnabled: true, trialDays: 0 };
const DAY = 86_400_000;
const TRIAL_RULE = 'Essai gratuit';
export const OPERATORS = ['Wave', 'Orange Money', 'MTN MoMo', 'Moov Money'];

/** États de course où la commission est réservée sur le crédit (pas encore prélevée) */
const RESERVING = [DeliveryStatus.ACCEPTED, DeliveryStatus.PICKED_UP];

export const ruleLabel = (type: CommissionType, value: number) =>
  type === 'PERCENT' ? `${value} %` : `${money(Math.round(value))}`;

/**
 * Abonnement annuel + crédit prépayé :
 * - un livreur ne peut accepter une course que si son entreprise est abonnée et a assez de crédit disponible
 *   (crédit − commissions déjà réservées par ses courses en cours) : blocage strict ;
 * - la commission (sur le prix de la tournée) est prélevée quand la tournée se termine, même avec des échecs ;
 * - un litige donné au client rembourse la part de commission de cet arrêt.
 */
@Injectable()
export class BillingService implements OnModuleInit {
  private cfg: BillingConfig = structuredClone(DEFAULT);

  constructor(
    private db: DataSource,
    @InjectRepository(Setting) private settings: Repository<Setting>,
    @InjectRepository(Company) private companies: Repository<Company>,
    @InjectRepository(Payment) private payments: Repository<Payment>,
    @InjectRepository(CreditTransaction) private txs: Repository<CreditTransaction>,
    private tracking: TrackingGateway,
    private independents: IndependentsService,
    private notify: NotifyService,
  ) {}

  /** Alerte « crédit insuffisant » : au plus une toutes les 10 minutes par entreprise */
  private lowAlertAt = new Map<string, number>();

  async onModuleInit() {
    const row = await this.settings.findOneBy({ key: KEY });
    if (row) this.cfg = { ...DEFAULT, ...(row.value as Partial<BillingConfig>) };
  }

  // ---------- Réglages (SA) ----------

  get config() {
    return { ...this.cfg, operators: OPERATORS };
  }

  async updateConfig(input: Partial<BillingConfig>, by: string) {
    const next: BillingConfig = { ...this.cfg };
    if (input.subscriptionEnabled !== undefined) {
      if (typeof input.subscriptionEnabled !== 'boolean') throw new BadRequestException('Abonnement : oui ou non attendu');
      next.subscriptionEnabled = input.subscriptionEnabled;
    }
    if (input.trialDays !== undefined) next.trialDays = this.int(input.trialDays, 'Essai gratuit (jours)', 0, 365);
    if (input.subscriptionFee !== undefined) next.subscriptionFee = this.int(input.subscriptionFee, 'Abonnement annuel', 0, 100_000_000);
    if (input.commissionType !== undefined || input.commissionValue !== undefined) {
      const { type, value } = this.validRule(input.commissionType ?? next.commissionType, input.commissionValue ?? next.commissionValue);
      next.commissionType = type;
      next.commissionValue = value;
    }
    if (input.accounts !== undefined) {
      if (!Array.isArray(input.accounts) || input.accounts.length > 10) throw new BadRequestException('10 comptes maximum');
      next.accounts = input.accounts.map((a, i) => {
        const operator = String(a?.operator ?? '').trim();
        const number = String(a?.number ?? '').replace(/\s/g, '');
        const name = String(a?.name ?? '').trim();
        if (!OPERATORS.includes(operator)) throw new BadRequestException(`Compte ${i + 1} : opérateur inconnu`);
        if (!/^0\d{9}$/.test(number)) throw new BadRequestException(`Compte ${i + 1} : numéro à 10 chiffres attendu`);
        if (!name || name.length > 60) throw new BadRequestException(`Compte ${i + 1} : nom du titulaire requis`);
        return { operator, number, name };
      });
    }
    await this.settings.save({ key: KEY, value: next, updatedBy: by });
    this.cfg = next;
    return this.config;
  }

  // ---------- Règles ----------

  /** Règle de commission : propre à l'entreprise, sinon règle LI (livreur indépendant) ou règle par défaut */
  rule(c: Pick<Company, 'commissionType' | 'commissionValue'> & { independent?: boolean }) {
    const custom = c.commissionType != null && c.commissionValue != null;
    const base = c.independent ? this.independents.config : this.cfg;
    const type = custom ? c.commissionType : base.commissionType;
    const value = custom ? c.commissionValue : base.commissionValue;
    return { type, value, custom, label: ruleLabel(type, value) };
  }

  commission(c: Pick<Company, 'commissionType' | 'commissionValue'> & { independent?: boolean }, price: number) {
    const r = this.rule(c);
    const amount = r.type === 'PERCENT' ? Math.round((price * r.value) / 100) : Math.round(r.value);
    return { amount: Math.max(0, amount), label: r.label };
  }

  /** Commissions réservées par les courses en cours de l'entreprise */
  private async reserved(m: EntityManager, companyId: string) {
    const [row] = await m.query(
      `SELECT coalesce(sum(CASE WHEN "commissionChargedAt" IS NULL THEN coalesce("commissionAmount", 0) ELSE 0 END
                         + CASE WHEN "affiliateChargedAt" IS NULL THEN coalesce("affiliateCommissionAmount", 0) ELSE 0 END), 0)::int AS total
         FROM deliveries
        WHERE "companyId" = $1 AND status = ANY($2)`,
      [companyId, RESERVING],
    );
    return row.total as number;
  }

  /** Abonnement actif (les livreurs indépendants n'en ont pas ; inutile si le SA a désactivé les abonnements ou pendant l'essai) */
  subscribed(c: Company) {
    if (c.independent || !this.cfg.subscriptionEnabled || this.inTrial(c)) return true;
    return !!c.subscriptionEndsAt && c.subscriptionEndsAt.getTime() > Date.now();
  }

  /** Essai gratuit en cours (entreprises uniquement) */
  inTrial(c: Pick<Company, 'trialEndsAt'> & { independent?: boolean }) {
    return !c.independent && !!c.trialEndsAt && c.trialEndsAt.getTime() > Date.now();
  }

  /** Fin d'essai pour une entreprise validée ou créée maintenant (null si pas d'essai) */
  trialEndFromNow() {
    return this.cfg.trialDays > 0 ? new Date(Date.now() + this.cfg.trialDays * DAY) : null;
  }

  /** Jours d'essai restants (arrondi au jour supérieur) */
  private trialDaysLeft(c: Company) {
    return this.inTrial(c) ? Math.ceil((c.trialEndsAt!.getTime() - Date.now()) / DAY) : 0;
  }

  /**
   * Vérifie qu'une entreprise peut prendre une course à ce prix et renvoie la commission à réserver.
   * Dans une transaction, la ligne de l'entreprise est verrouillée (deux acceptations simultanées ne peuvent pas dépasser le crédit).
   */
  async reserve(m: EntityManager, companyId: string | null, price: number) {
    if (!companyId) throw new BadRequestException('Livreur sans entreprise : contactez LETO');
    const c = await m.getRepository(Company).createQueryBuilder('c').setLock('pessimistic_write').where('c.id = :id', { id: companyId }).getOne();
    if (c?.independent) return this.reserveIndependent(m, c, price);
    if (!c || !c.active) throw new BadRequestException('Votre entreprise est suspendue : contactez votre gérant');
    // Essai gratuit : course sans commission, crédit non nécessaire
    if (this.inTrial(c)) return { commissionAmount: 0, commissionRule: TRIAL_RULE };
    if (!this.subscribed(c)) throw new BadRequestException('L’abonnement annuel de votre entreprise n’est pas actif : contactez votre gérant');
    const { amount, label } = this.commission(c, price);
    const available = c.credit - (await this.reserved(m, companyId));
    if (available < amount) {
      this.tracking.emitToCompany(companyId, 'billing:low', { available, needed: amount });
      if (Date.now() - (this.lowAlertAt.get(companyId) ?? 0) > 10 * 60_000) {
        this.lowAlertAt.set(companyId, Date.now());
        this.notify.office({ companyId }, 'CREDIT_LOW', {
          title: 'Crédit insuffisant',
          body: `Un livreur n’a pas pu accepter une course : il manque ${money(amount - Math.max(0, available))}. Rechargez votre crédit.`,
          link: '/credit',
        });
      }
      throw new BadRequestException('Crédit de votre entreprise insuffisant pour cette course : demandez à votre gérant de recharger');
    }
    return { commissionAmount: amount, commissionRule: label };
  }

  /** Livreur indépendant : dossier validé, LI activés par LETO, solde suffisant */
  private async reserveIndependent(m: EntityManager, c: Company, price: number) {
    const blocked = await this.independents.blocker(c.id);
    if (blocked) throw new BadRequestException(blocked);
    if (!c.active) throw new BadRequestException('Votre compte est suspendu par LETO');
    const { amount, label } = this.commission(c, price);
    // Rattaché à une entreprise : sa commission est aussi prélevée sur le solde du LI
    const aff = await this.affiliateCommission(c.id, price);
    const total = amount + (aff?.affiliateCommissionAmount ?? 0);
    const available = c.credit - (await this.reserved(m, c.id));
    if (available < total) {
      throw new BadRequestException(
        `Solde insuffisant pour cette course (commissions ${money(total)}${aff ? `, dont ${money(aff.affiliateCommissionAmount)} pour votre entreprise` : ''}) : rechargez votre compte`,
      );
    }
    return { commissionAmount: amount, commissionRule: label, ...(aff ?? {}) };
  }

  /** Commission de l'entreprise de rattachement d'un LI (taux accepté par le LI, plafonné par LETO) */
  async affiliateCommission(liCompanyId: string, price: number) {
    const [p] = await this.db.query(
      `SELECT "affiliatedCompanyId", "affCommissionType", "affCommissionValue" FROM independent_profiles WHERE "companyId" = $1`,
      [liCompanyId],
    );
    if (!p?.affiliatedCompanyId || !p.affCommissionType) return null;
    const value = this.independents.capRule(p.affCommissionType, Number(p.affCommissionValue ?? 0));
    return {
      affiliateCompanyId: p.affiliatedCompanyId as string,
      affiliateRuleType: p.affCommissionType as 'PERCENT' | 'FIXED',
      affiliateRuleValue: value,
      affiliateCommissionAmount: this.ruleAmount(p.affCommissionType, value, price),
    };
  }

  private ruleAmount(type: 'PERCENT' | 'FIXED', value: number, price: number) {
    return Math.max(0, type === 'PERCENT' ? Math.round((price * value) / 100) : Math.round(value));
  }

  /** Vérification seule, sans réserver (ex. avant une proposition de prix) */
  check(companyId: string | null, price: number) {
    return this.db.transaction((m) => this.reserve(m, companyId, price));
  }

  /** État pour l'app livreur (bandeau « crédit insuffisant », « abonnement expiré ») */
  async driverStatus(companyId: string | null) {
    if (!companyId) return { ok: false, reason: 'Livreur sans entreprise' };
    const c = await this.companies.findOneBy({ id: companyId });
    if (c?.independent) {
      const blocked = await this.independents.blocker(c.id);
      if (blocked) return { ok: false, reason: blocked, independent: true };
      const left = c.credit - (await this.reserved(this.db.manager, companyId));
      if (left <= 0) return { ok: false, reason: 'Solde épuisé : rechargez votre compte pour prendre des courses', independent: true };
      return { ok: true, reason: null, independent: true };
    }
    if (!c?.active) return { ok: false, reason: 'Votre entreprise est suspendue' };
    if (this.inTrial(c)) return { ok: true, reason: null, trialDaysLeft: this.trialDaysLeft(c) };
    if (!this.subscribed(c)) return { ok: false, reason: 'Abonnement de votre entreprise expiré : contactez votre gérant' };
    const available = c.credit - (await this.reserved(this.db.manager, companyId));
    if (available <= 0) return { ok: false, reason: 'Crédit de votre entreprise épuisé : contactez votre gérant' };
    return { ok: true, reason: null };
  }

  /** Prix modifié avant la fin (arrêt retiré, frais de retour ou de nouvelle tentative) : la commission réservée suit le total */
  async recompute(deliveryId: string) {
    const d = await this.db.getRepository(Delivery).findOneBy({ id: deliveryId });
    if (!d?.companyId || d.commissionAmount == null || d.commissionChargedAt || d.commissionRule === TRIAL_RULE) return;
    const c = await this.companies.findOneBy({ id: d.companyId });
    if (!c) return;
    const { amount, label } = this.commission(c, d.price + (d.extraFees ?? 0));
    await this.db.getRepository(Delivery).update(d.id, { commissionAmount: amount, commissionRule: label });
    if (d.affiliateRuleType && !d.affiliateChargedAt) {
      await this.db.getRepository(Delivery).update(d.id, {
        affiliateCommissionAmount: this.ruleAmount(d.affiliateRuleType, d.affiliateRuleValue ?? 0, d.price + (d.extraFees ?? 0)),
      });
    }
  }

  /** Fin de tournée : prélève la commission réservée (une seule fois) */
  async charge(deliveryId: string) {
    await this.db.transaction(async (m) => {
      const d = await m.getRepository(Delivery).createQueryBuilder('d').setLock('pessimistic_write').where('d.id = :id', { id: deliveryId }).getOne();
      if (!d?.companyId) return;
      if (!d.commissionChargedAt && d.commissionAmount) {
        await this.move(m, d.companyId, CreditType.COMMISSION, -d.commissionAmount, { deliveryId, note: `Commission ${d.commissionRule ?? ''}`.trim() });
        await m.update(Delivery, d.id, { commissionChargedAt: new Date() });
      }
      // LI rattaché : commission de son entreprise, versée dans ses gains (disponibles après le délai de sécurité)
      if (d.affiliateCompanyId && !d.affiliateChargedAt && d.affiliateCommissionAmount) {
        const aff = await m.findOneBy(Company, { id: d.affiliateCompanyId });
        await this.move(m, d.companyId, CreditType.AFFILIATE_COMMISSION, -d.affiliateCommissionAmount, {
          deliveryId,
          note: `Commission ${aff?.name ?? 'de votre entreprise'}`,
        });
        await m.save(CompanyEarning, {
          companyId: d.affiliateCompanyId,
          type: EarningType.COMMISSION,
          amount: d.affiliateCommissionAmount,
          availableAt: new Date(Date.now() + this.independents.config.earningsHoldHours * 3_600_000),
          deliveryId,
          driverId: d.driverId,
          note: 'Course d’un livreur indépendant',
        });
        await m.update(Delivery, d.id, { affiliateChargedAt: new Date() });
        this.tracking.emitToCompany(d.affiliateCompanyId, 'earnings:changed', {});
      }
    });
  }

  /** Litige donné au client : rembourse la part de commission de l'arrêt */
  async refundStop(deliveryId: string, by: string) {
    await this.db.transaction(async (m) => {
      const d = await m.getRepository(Delivery).createQueryBuilder('d').setLock('pessimistic_write').where('d.id = :id', { id: deliveryId }).getOne();
      if (!d?.companyId) return;
      const stops = await m.query(`SELECT count(*)::int AS n FROM delivery_stops WHERE "deliveryId" = $1`, [deliveryId]);
      const n = Math.max(1, stops[0].n);
      if (d.commissionChargedAt && d.commissionAmount) {
        const share = Math.min(Math.round(d.commissionAmount / n), d.commissionAmount - d.commissionRefunded);
        if (share > 0) {
          await this.move(m, d.companyId, CreditType.REFUND, share, { deliveryId, note: 'Litige donné au client', by });
          await m.update(Delivery, d.id, { commissionRefunded: d.commissionRefunded + share });
        }
      }
      // Part de l'entreprise de rattachement : rendue au LI, reprise sur les gains de l'entreprise
      if (d.affiliateCompanyId && d.affiliateChargedAt && d.affiliateCommissionAmount) {
        const share = Math.min(Math.round(d.affiliateCommissionAmount / n), d.affiliateCommissionAmount - d.affiliateRefunded);
        if (share > 0) {
          await this.move(m, d.companyId, CreditType.REFUND, share, { deliveryId, note: 'Litige donné au client (part de l’entreprise)', by });
          await m.save(CompanyEarning, {
            companyId: d.affiliateCompanyId,
            type: EarningType.REVERSAL,
            amount: -share,
            availableAt: new Date(),
            deliveryId,
            driverId: d.driverId,
            note: 'Litige donné au client',
            createdBy: by,
          });
          await m.update(Delivery, d.id, { affiliateRefunded: d.affiliateRefunded + share });
        }
      }
    });
  }

  /** Gains LI de l'entreprise transférés vers son crédit (dans la transaction de l'appelant) */
  creditFromEarnings(m: EntityManager, companyId: string, amount: number, by: string) {
    return this.move(m, companyId, CreditType.EARNINGS_TRANSFER, amount, { note: 'Gains des livreurs indépendants', by });
  }

  /** Mouvement de crédit : met à jour le solde et l'inscrit au journal */
  private async move(
    m: EntityManager,
    companyId: string,
    type: CreditType,
    amount: number,
    extra: { deliveryId?: string; paymentId?: string; note?: string; by?: string } = {},
  ) {
    const c = await m.getRepository(Company).createQueryBuilder('c').setLock('pessimistic_write').where('c.id = :id', { id: companyId }).getOne();
    if (!c) throw new NotFoundException('Entreprise introuvable');
    const balanceAfter = c.credit + amount;
    if (type === CreditType.ADJUSTMENT && balanceAfter < 0) throw new BadRequestException(`Le crédit ne peut pas devenir négatif (solde : ${money(c.credit)})`);
    await m.update(Company, companyId, { credit: balanceAfter });
    await m.save(CreditTransaction, {
      companyId,
      type,
      amount,
      balanceAfter,
      deliveryId: extra.deliveryId ?? null,
      paymentId: extra.paymentId ?? null,
      note: extra.note ?? null,
      createdBy: extra.by ?? null,
    });
    this.tracking.emitToCompany(companyId, 'billing:changed', { companyId, credit: balanceAfter });
    return balanceAfter;
  }

  // ---------- Vue d'ensemble d'une entreprise ----------

  async overview(companyId: string) {
    const c = await this.companies.findOneBy({ id: companyId });
    if (!c) throw new NotFoundException('Entreprise introuvable');
    const reserved = await this.reserved(this.db.manager, companyId);
    const [transactions, payments, [month]] = await Promise.all([
      this.txs.find({ where: { companyId }, order: { createdAt: 'DESC' }, take: 200 }),
      this.payments.find({ where: { companyId }, order: { createdAt: 'DESC' }, take: 100 }),
      this.db.query(
        `SELECT coalesce(-sum(amount) FILTER (WHERE type = 'COMMISSION'), 0)::int AS commissions,
                coalesce(sum(amount) FILTER (WHERE type = 'TOPUP'), 0)::int AS topups
           FROM credit_transactions WHERE "companyId" = $1 AND "createdAt" >= date_trunc('month', now())`,
        [companyId],
      ),
    ]);
    return {
      credit: c.credit,
      reserved,
      available: c.credit - reserved,
      subscriptionEndsAt: c.subscriptionEndsAt,
      subscribed: this.subscribed(c),
      subscriptionRequired: this.cfg.subscriptionEnabled,
      trialEndsAt: c.trialEndsAt,
      inTrial: this.inTrial(c),
      trialDaysLeft: this.trialDaysLeft(c),
      rule: this.rule(c),
      month,
      config: this.config,
      transactions,
      payments,
    };
  }

  // ---------- Paiements (preuves Mobile Money) ----------

  async submit(companyId: string, by: string, dto: { kind: PaymentKind; amount: number; operator: string; senderPhone: string; reference?: string; proofUrl: string }) {
    if (!OPERATORS.includes(dto.operator)) throw new BadRequestException('Opérateur inconnu');
    if (dto.kind === PaymentKind.SUBSCRIPTION && !this.cfg.subscriptionEnabled) throw new BadRequestException('Les abonnements ne sont pas demandés pour le moment');
    if (dto.kind === PaymentKind.SUBSCRIPTION && dto.amount < this.cfg.subscriptionFee) {
      throw new BadRequestException(`L’abonnement annuel est de ${money(this.cfg.subscriptionFee)}`);
    }
    if (await this.payments.existsBy({ companyId, status: PaymentStatus.PENDING, kind: dto.kind, amount: dto.amount, senderPhone: dto.senderPhone })) {
      throw new BadRequestException('Ce paiement est déjà en cours de vérification');
    }
    const p = await this.payments.save(this.payments.create({ ...dto, reference: dto.reference || null, companyId, submittedBy: by }));
    this.tracking.emitToCompany(companyId, 'payment:new', { id: p.id });
    const co = await this.companies.findOneBy({ id: companyId });
    this.notify.office({ sa: true }, 'PAYMENT', {
      title: 'Paiement à vérifier',
      body: `${co?.name ?? 'Une entreprise'} · ${dto.kind === PaymentKind.SUBSCRIPTION ? 'abonnement' : 'recharge'} de ${money(dto.amount)} (${dto.operator})`,
      link: '/paiements',
    });
    return p;
  }

  list(status?: PaymentStatus) {
    return this.payments.find({ where: status ? { status } : {}, relations: { company: true }, order: { createdAt: 'DESC' }, take: 300 });
  }

  async approve(id: string, by: string, amount?: number) {
    const result = await this.db.transaction(async (m) => {
      const p = await m.getRepository(Payment).createQueryBuilder('p').setLock('pessimistic_write').where('p.id = :id', { id }).getOne();
      if (!p) throw new NotFoundException('Paiement introuvable');
      if (p.status !== PaymentStatus.PENDING) throw new BadRequestException('Paiement déjà traité');
      // Le SA peut corriger le montant réellement reçu
      const received = amount ?? p.amount;
      if (p.kind === PaymentKind.TOPUP) {
        await this.move(m, p.companyId, CreditType.TOPUP, received, { paymentId: p.id, note: `${p.operator} · ${p.senderPhone}`, by });
      } else {
        const c = await m.findOneBy(Company, { id: p.companyId });
        const from = c.subscriptionEndsAt && c.subscriptionEndsAt.getTime() > Date.now() ? c.subscriptionEndsAt : new Date();
        const end = new Date(from);
        end.setFullYear(end.getFullYear() + 1);
        await m.update(Company, p.companyId, { subscriptionEndsAt: end });
      }
      await m.update(Payment, p.id, { status: PaymentStatus.APPROVED, amount: received, reviewedBy: by, reviewedAt: new Date() });
      return p;
    });
    this.tracking.emitToCompany(result.companyId, 'billing:changed', { companyId: result.companyId });
    this.notify.office({ companyId: result.companyId }, 'PAYMENT', {
      title: 'Paiement validé',
      body: result.kind === PaymentKind.TOPUP ? `${money(amount ?? result.amount)} ajouté(s) à votre crédit` : 'Votre abonnement est prolongé d’un an',
      link: '/credit',
    });
    return this.payments.findOne({ where: { id }, relations: { company: true } });
  }

  async reject(id: string, by: string, note: string) {
    const res = await this.payments.update({ id, status: PaymentStatus.PENDING }, { status: PaymentStatus.REJECTED, reviewNote: note, reviewedBy: by, reviewedAt: new Date() });
    if (!res.affected) throw new BadRequestException('Paiement déjà traité');
    const p = await this.payments.findOne({ where: { id }, relations: { company: true } });
    this.tracking.emitToCompany(p.companyId, 'billing:changed', { companyId: p.companyId });
    this.notify.office({ companyId: p.companyId }, 'PAYMENT', { title: 'Paiement refusé', body: `${money(p.amount)} : ${note}`, link: '/credit' });
    return p;
  }

  // ---------- Actions du SA sur une entreprise ----------

  adjust(companyId: string, amount: number, note: string, by: string) {
    if (!Number.isInteger(amount) || amount === 0) throw new BadRequestException('Montant entier non nul attendu');
    return this.db.transaction((m) => this.move(m, companyId, CreditType.ADJUSTMENT, amount, { note, by }));
  }

  async setSubscription(companyId: string, endsAt: string | null) {
    const date = endsAt ? new Date(endsAt) : null;
    if (date && Number.isNaN(date.getTime())) throw new BadRequestException('Date invalide');
    await this.companies.update(companyId, { subscriptionEndsAt: date });
    return this.overview(companyId);
  }

  /** SA : fin de l'essai gratuit d'une entreprise (null = pas d'essai / arrêter l'essai) */
  async setTrial(companyId: string, endsAt: string | null) {
    const date = endsAt ? new Date(endsAt) : null;
    if (date && Number.isNaN(date.getTime())) throw new BadRequestException('Date invalide');
    const c = await this.companies.findOneBy({ id: companyId });
    if (!c) throw new NotFoundException('Entreprise introuvable');
    if (c.independent) throw new BadRequestException('Les livreurs indépendants n’ont pas d’essai gratuit');
    await this.companies.update(companyId, { trialEndsAt: date });
    this.tracking.emitToCompany(companyId, 'billing:changed', { companyId });
    return this.overview(companyId);
  }

  async setCommission(companyId: string, type: CommissionType | null, value: number | null) {
    if (type == null || value == null) {
      await this.companies.update(companyId, { commissionType: null, commissionValue: null });
    } else {
      const r = this.validRule(type, value);
      await this.companies.update(companyId, { commissionType: r.type, commissionValue: r.value });
    }
    return this.overview(companyId);
  }

  /** Commissions prélevées par entreprise (tableau de bord du SA) */
  async summary() {
    const [row] = await this.db.query(
      `SELECT coalesce(-sum(amount) FILTER (WHERE type = 'COMMISSION' AND "createdAt" >= date_trunc('month', now())), 0)::int AS "commissionsMonth",
              coalesce(-sum(amount) FILTER (WHERE type IN ('COMMISSION', 'REFUND')), 0)::int AS "commissionsTotal",
              coalesce(sum(amount) FILTER (WHERE type = 'TOPUP' AND "createdAt" >= date_trunc('month', now())), 0)::int AS "topupsMonth"
         FROM credit_transactions`,
    );
    const pending = await this.payments.countBy({ status: PaymentStatus.PENDING });
    const [subs] = await this.db.query(
      `SELECT coalesce(sum(amount) FILTER (WHERE "reviewedAt" >= date_trunc('year', now())), 0)::int AS "subscriptionsYear"
         FROM payments WHERE kind = 'SUBSCRIPTION' AND status = 'APPROVED'`,
    );
    return { ...row, ...subs, pending };
  }

  private validRule(type: CommissionType, value: number) {
    if (type !== 'PERCENT' && type !== 'FIXED') throw new BadRequestException('Type de commission : pourcentage ou montant fixe');
    const v = type === 'PERCENT' ? Number(value) : this.int(value, 'Commission fixe', 0, 1_000_000);
    if (type === 'PERCENT' && (!Number.isFinite(v) || v < 0 || v > 100)) throw new BadRequestException('Pourcentage entre 0 et 100');
    return { type, value: type === 'PERCENT' ? Math.round(v * 100) / 100 : v };
  }

  private int(v: unknown, name: string, min: number, max: number) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new BadRequestException(`${name} : nombre entier entre ${min} et ${max}`);
    return n;
  }
}
