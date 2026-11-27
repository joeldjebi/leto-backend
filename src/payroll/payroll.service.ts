import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource, In, Repository } from 'typeorm';
import { Company } from '../companies/company.entity';
import { money } from '../countries/phone';
import { NotifyService } from '../notifications/notify.service';
import { Remittance, RemittanceStatus } from '../remittances/remittance.entity';
import { RemittancesService } from '../remittances/remittances.service';
import { TrackingGateway } from '../tracking/tracking.gateway';
import { Role, User } from '../users/user.entity';
import { AdvanceStatus, PayAdvance, PayLine, PayPeriod, PayRule, Payslip, PayslipStatus } from './payroll.entities';
import { periodLabel, periodOf, recentPeriods } from './periods';

const DEFAULT_RULE: PayRule = { fixed: 0, perStop: 0, percent: 0, ratingBonus: null, volumeBonus: null };
const PERIODS: PayPeriod[] = ['WEEK', 'FORTNIGHT', 'MONTH'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Activité d'un livreur sur une période */
interface Activity { deliveries: number; stops: number; revenue: number; ratingAvg: number | null; ratings: number }

/**
 * Paye interne des livreurs d'une entreprise : règle de rémunération, fiches de paie par période
 * (semaine, quinzaine, mois), primes et retenues, avances, compensation automatique des espèces
 * encaissées non versées. VITE calcule et garde les traces ; l'entreprise paie elle-même.
 */
@Injectable()
export class PayrollService {
  constructor(
    private db: DataSource,
    @InjectRepository(Payslip) private slips: Repository<Payslip>,
    @InjectRepository(PayAdvance) private advances: Repository<PayAdvance>,
    @InjectRepository(Company) private companies: Repository<Company>,
    @InjectRepository(User) private users: Repository<User>,
    private remittances: RemittancesService,
    private tracking: TrackingGateway,
    private notify: NotifyService,
  ) {}

  // ---------- Réglages ----------

  private async company(companyId: string) {
    const c = await this.companies.findOneBy({ id: companyId });
    if (!c || c.independent) throw new ForbiddenException('Réservé aux entreprises de livraison');
    return c;
  }

  static checkRule(r: Partial<PayRule> | null | undefined): PayRule {
    const n = (v: unknown, name: string, max: number) => {
      const x = Number(v ?? 0);
      if (!Number.isFinite(x) || x < 0 || x > max) throw new BadRequestException(`${name} : entre 0 et ${max}`);
      return x;
    };
    const rule: PayRule = {
      fixed: Math.round(n(r?.fixed, 'Fixe par période', 10_000_000)),
      perStop: Math.round(n(r?.perStop, 'Montant par colis livré', 100_000)),
      percent: Math.round(n(r?.percent, 'Pourcentage du prix des courses', 100) * 100) / 100,
      ratingBonus: r?.ratingBonus ? { min: n(r.ratingBonus.min, 'Note minimum de la prime', 5), amount: Math.round(n(r.ratingBonus.amount, 'Prime note', 1_000_000)) } : null,
      volumeBonus: r?.volumeBonus ? { stops: Math.round(n(r.volumeBonus.stops, 'Colis pour la prime', 100_000)), amount: Math.round(n(r.volumeBonus.amount, 'Prime volume', 1_000_000)) } : null,
    };
    return rule;
  }

  async settings(companyId: string) {
    const c = await this.company(companyId);
    const drivers = await this.users.find({ where: { companyId, role: Role.DRIVER }, order: { name: 'ASC' } });
    return {
      enabled: c.payrollEnabled,
      period: c.payPeriod,
      rule: c.payRule ?? DEFAULT_RULE,
      sharePercent: c.driverSharePercent ?? 0,
      drivers: drivers.map((d) => ({ id: d.id, name: d.name, active: d.active, rule: d.payRule })),
    };
  }

  async setSettings(companyId: string, dto: { enabled?: boolean; period?: PayPeriod; rule?: Partial<PayRule> }) {
    await this.company(companyId);
    const patch: Partial<Company> = {};
    if (dto.period !== undefined) {
      if (!PERIODS.includes(dto.period)) throw new BadRequestException('Période : semaine, quinzaine ou mois');
      patch.payPeriod = dto.period;
    }
    if (dto.rule !== undefined) patch.payRule = PayrollService.checkRule(dto.rule);
    if (dto.enabled !== undefined) {
      patch.payrollEnabled = !!dto.enabled;
      // La paye remplace la part gardée par le livreur sur ses encaissements (pas de double rémunération)
      if (dto.enabled) patch.driverSharePercent = 0;
    }
    await this.companies.update(companyId, patch);
    return this.settings(companyId);
  }

  async setDriverRule(companyId: string, driverId: string, rule: Partial<PayRule> | null) {
    const d = await this.users.findOneBy({ id: driverId, companyId, role: Role.DRIVER });
    if (!d) throw new NotFoundException('Livreur introuvable');
    await this.users.update(driverId, { payRule: rule ? PayrollService.checkRule(rule) : null });
    return this.settings(companyId);
  }

  // ---------- Calcul ----------

  private async activity(companyId: string, driverId: string, start: string, end: string): Promise<Activity> {
    const [r] = await this.db.query(
      `SELECT (SELECT count(*)::int FROM deliveries d WHERE d."driverId" = $1 AND d."companyId" = $2 AND d.status = 'DELIVERED'
                AND d."deliveredAt" >= $3::date AND d."deliveredAt" < $4::date + 1) AS deliveries,
              (SELECT coalesce(sum(d.price + coalesce(d."extraFees", 0)), 0)::int FROM deliveries d WHERE d."driverId" = $1 AND d."companyId" = $2 AND d.status = 'DELIVERED'
                AND d."deliveredAt" >= $3::date AND d."deliveredAt" < $4::date + 1) AS revenue,
              (SELECT count(*)::int FROM delivery_stops s JOIN deliveries d ON d.id = s."deliveryId" WHERE d."driverId" = $1 AND d."companyId" = $2
                AND s.status = 'DELIVERED' AND s."deliveredAt" >= $3::date AND s."deliveredAt" < $4::date + 1) AS stops,
              (SELECT avg(d.rating)::float FROM deliveries d WHERE d."driverId" = $1 AND d.rating IS NOT NULL AND d."ratedAt" >= $3::date AND d."ratedAt" < $4::date + 1) AS "ratingAvg",
              (SELECT count(*)::int FROM deliveries d WHERE d."driverId" = $1 AND d.rating IS NOT NULL AND d."ratedAt" >= $3::date AND d."ratedAt" < $4::date + 1) AS ratings`,
      [driverId, companyId, start, end],
    );
    return { deliveries: r.deliveries, stops: r.stops, revenue: r.revenue, ratingAvg: r.ratingAvg == null ? null : Number(r.ratingAvg), ratings: r.ratings };
  }

  /** Lignes de la fiche : gains (règle), primes automatiques, lignes manuelles, avances à retenir */
  private async build(company: Company, driver: User, start: string, end: string, manual: PayLine[], deductedAdvances?: string[]) {
    const rule = driver.payRule ?? company.payRule ?? DEFAULT_RULE;
    const a = await this.activity(company.id, driver.id, start, end);
    const lines: PayLine[] = [];
    const add = (kind: PayLine['kind'], label: string, amount: number) => amount && lines.push({ id: randomUUID(), kind, label, amount: Math.round(amount) });
    add('FIXED', 'Fixe de la période', rule.fixed);
    add('STOPS', `${a.stops} colis livré(s) × ${money(rule.perStop)}`, a.stops * rule.perStop);
    add('PERCENT', `${rule.percent} % de ${money(a.revenue)} de courses`, (a.revenue * rule.percent) / 100);
    if (rule.volumeBonus && a.stops >= rule.volumeBonus.stops) add('BONUS', `Prime volume (${rule.volumeBonus.stops} colis et plus)`, rule.volumeBonus.amount);
    if (rule.ratingBonus && a.ratingAvg != null && a.ratings >= 5 && a.ratingAvg >= rule.ratingBonus.min) {
      add('BONUS', `Prime bonne note (${a.ratingAvg.toFixed(1)}★ sur ${a.ratings} avis)`, rule.ratingBonus.amount);
    }
    lines.push(...manual.filter((l) => l.manual));
    // Avances versées jusqu'à la fin de la période, pas encore retenues
    const adv = deductedAdvances
      ? await this.advances.findBy({ id: In(deductedAdvances.length ? deductedAdvances : ['00000000-0000-0000-0000-000000000000']) })
      : await this.db.query(
          `SELECT * FROM pay_advances WHERE "driverId" = $1 AND "companyId" = $2 AND status = 'GIVEN' AND "payslipId" IS NULL AND "decidedAt" < $3::date + 1 ORDER BY "decidedAt"`,
          [driver.id, company.id, end],
        );
    for (const x of adv) lines.push({ id: randomUUID(), kind: 'ADVANCE', label: `Avance du ${new Date(x.decidedAt).toLocaleDateString('fr-FR')}`, amount: -x.amount, advanceId: x.id });
    const gross = lines.reduce((t, l) => t + l.amount, 0);
    return { rule, activity: a, lines, gross };
  }

  /** Espèces encaissées non versées : déduites de la paie (jusqu'au montant de la paie) */
  private async cashToCompensate(companyId: string, driverId: string, gross: number) {
    const [b] = await this.remittances.balances(companyId, driverId);
    const owed = Math.max(0, (b?.toRemit ?? 0) - (b?.pending ?? 0));
    return { owed, compensated: Math.max(0, Math.min(owed, gross)) };
  }

  private view(s: Payslip, driverName?: string) {
    return { ...s, label: periodLabel(s.period, s.periodStart, s.periodEnd), driverName };
  }

  private checkStart(company: Company, start?: string) {
    if (!start) return periodOf(company.payPeriod);
    if (!DATE.test(start)) throw new BadRequestException('Période invalide');
    return periodOf(company.payPeriod, new Date(`${start}T12:00:00Z`));
  }

  /** Paye d'une période : fiches existantes, sinon estimation ; avances ; périodes récentes */
  async overview(companyId: string, start?: string) {
    const company = await this.company(companyId);
    const p = this.checkStart(company, start);
    const drivers = await this.users.find({ where: { companyId, role: Role.DRIVER }, order: { name: 'ASC' } });
    const existing = await this.slips.find({ where: { companyId, periodStart: p.start } });
    const rows = [];
    for (const d of drivers) {
      const s = existing.find((x) => x.driverId === d.id);
      if (s) {
        // Brouillon : compensation estimée avec les espèces actuelles
        const cash = s.status === PayslipStatus.DRAFT ? await this.cashToCompensate(companyId, d.id, s.gross) : null;
        rows.push({ driverId: d.id, name: d.name, active: d.active, payslip: this.view(s), estimate: cash ? { cashCompensated: cash.compensated, net: s.gross - cash.compensated, cashOwed: cash.owed } : null });
      } else if (d.active) {
        const b = await this.build(company, d, p.start, p.end, []);
        const cash = await this.cashToCompensate(companyId, d.id, b.gross);
        rows.push({ driverId: d.id, name: d.name, active: d.active, payslip: null, estimate: { ...b.activity, gross: b.gross, cashCompensated: cash.compensated, net: b.gross - cash.compensated, cashOwed: cash.owed } });
      }
    }
    const advances = await this.db.query(
      `SELECT a.*, u.name AS "driverName" FROM pay_advances a JOIN users u ON u.id = a."driverId"
        WHERE a."companyId" = $1 AND (a.status IN ('PENDING', 'GIVEN') OR a."createdAt" > now() - interval '60 days') ORDER BY a."createdAt" DESC LIMIT 100`,
      [companyId],
    );
    return {
      enabled: company.payrollEnabled,
      period: company.payPeriod,
      start: p.start,
      end: p.end,
      label: periodLabel(company.payPeriod, p.start, p.end),
      current: p.start === periodOf(company.payPeriod).start,
      periods: recentPeriods(company.payPeriod, 8).map((x) => ({ ...x, label: periodLabel(company.payPeriod, x.start, x.end) })),
      rows,
      advances,
    };
  }

  /** Prépare (ou met à jour) les fiches de paie de la période pour tous les livreurs actifs */
  async prepare(companyId: string, start?: string) {
    const company = await this.company(companyId);
    if (!company.payrollEnabled) throw new BadRequestException('Activez d’abord la paye des livreurs');
    const p = this.checkStart(company, start);
    const drivers = await this.users.find({ where: { companyId, role: Role.DRIVER, active: true } });
    for (const d of drivers) {
      const s = await this.slips.findOneBy({ driverId: d.id, periodStart: p.start });
      if (s && s.status !== PayslipStatus.DRAFT) continue;
      const b = await this.build(company, d, p.start, p.end, s?.lines ?? []);
      await this.slips.save({ ...(s ?? {}), companyId, driverId: d.id, period: company.payPeriod, periodStart: p.start, periodEnd: p.end, status: PayslipStatus.DRAFT,
        deliveries: b.activity.deliveries, stops: b.activity.stops, revenue: b.activity.revenue, rule: b.rule, lines: b.lines, gross: b.gross });
    }
    return this.overview(companyId, p.start);
  }

  private async mine(companyId: string, id: string) {
    const s = await this.slips.findOneBy({ id, companyId });
    if (!s) throw new NotFoundException('Fiche de paie introuvable');
    return s;
  }

  async one(companyId: string, id: string) {
    const s = await this.mine(companyId, id);
    const d = await this.users.findOneBy({ id: s.driverId });
    const cash = s.status === PayslipStatus.DRAFT ? await this.cashToCompensate(companyId, s.driverId, s.gross) : null;
    return { ...this.view(s, d?.name), estimate: cash ? { cashCompensated: cash.compensated, net: s.gross - cash.compensated, cashOwed: cash.owed } : null };
  }

  private async recompute(s: Payslip) {
    const company = await this.company(s.companyId);
    const d = await this.users.findOneBy({ id: s.driverId });
    if (!d) throw new NotFoundException('Livreur introuvable');
    const b = await this.build(company, d, s.periodStart, s.periodEnd, s.lines);
    Object.assign(s, { deliveries: b.activity.deliveries, stops: b.activity.stops, revenue: b.activity.revenue, rule: b.rule, lines: b.lines, gross: b.gross });
    return this.slips.save(s);
  }

  async refresh(companyId: string, id: string) {
    const s = await this.mine(companyId, id);
    if (s.status !== PayslipStatus.DRAFT) throw new BadRequestException('Fiche déjà payée');
    await this.recompute(s);
    return this.one(companyId, id);
  }

  /** Prime ou retenue ajoutée à la main sur un brouillon */
  async addLine(companyId: string, id: string, dto: { kind: 'BONUS' | 'DEDUCTION'; label: string; amount: number }) {
    const s = await this.mine(companyId, id);
    if (s.status !== PayslipStatus.DRAFT) throw new BadRequestException('Fiche déjà payée');
    const amount = Math.abs(Math.round(dto.amount));
    if (!amount) throw new BadRequestException('Montant obligatoire');
    s.lines = [...s.lines, { id: randomUUID(), kind: dto.kind, label: dto.label.trim(), amount: dto.kind === 'DEDUCTION' ? -amount : amount, manual: true }];
    await this.recompute(s);
    return this.one(companyId, id);
  }

  async removeLine(companyId: string, id: string, lineId: string) {
    const s = await this.mine(companyId, id);
    if (s.status !== PayslipStatus.DRAFT) throw new BadRequestException('Fiche déjà payée');
    if (!s.lines.some((l) => l.id === lineId && l.manual)) throw new BadRequestException('Seules les primes et retenues ajoutées à la main se retirent');
    s.lines = s.lines.filter((l) => l.id !== lineId);
    await this.recompute(s);
    return this.one(companyId, id);
  }

  /** Paiement : espèces non versées déduites (enregistrées comme versement), avances retenues */
  async pay(companyId: string, id: string, dto: { method: 'CASH' | 'MOBILE_MONEY'; reference?: string; proofUrl?: string }, by: string) {
    const s = await this.mine(companyId, id);
    if (s.status !== PayslipStatus.DRAFT) throw new BadRequestException('Fiche déjà payée');
    await this.recompute(s);
    const label = periodLabel(s.period, s.periodStart, s.periodEnd);
    const cash = await this.cashToCompensate(companyId, s.driverId, s.gross);
    await this.db.transaction(async (m) => {
      if (cash.compensated > 0) {
        await m.save(Remittance, {
          companyId, driverId: s.driverId, amount: cash.compensated, method: 'PAYROLL', status: RemittanceStatus.CONFIRMED, createdBy: 'COMPANY',
          note: `Déduit de la paie · ${label}`, reviewedBy: by, reviewedAt: new Date(), reference: null, proofUrl: null,
        });
      }
      const advanceIds = s.lines.filter((l) => l.advanceId).map((l) => l.advanceId!);
      if (advanceIds.length) await m.update(PayAdvance, { id: In(advanceIds), status: AdvanceStatus.GIVEN }, { status: AdvanceStatus.DEDUCTED, payslipId: s.id });
      const lines = cash.compensated ? [...s.lines, { id: randomUUID(), kind: 'CASH' as const, label: 'Espèces encaissées non versées (déduites)', amount: -cash.compensated }] : s.lines;
      await m.update(Payslip, s.id, {
        status: PayslipStatus.PAID, lines, cashCompensated: cash.compensated, net: s.gross - cash.compensated,
        paidAt: new Date(), paidBy: by, method: dto.method, reference: dto.reference?.trim() || null, proofUrl: dto.proofUrl || null,
      });
    });
    const net = s.gross - cash.compensated;
    this.notify.send([s.driverId], 'CLIENT_UPDATE', {
      title: 'Paie versée',
      body: `${label} : ${money(net)}${cash.compensated ? ` (${money(cash.compensated)} d’espèces non versées déduites)` : ''}. Confirmez la réception dans l’app.`,
    });
    this.tracking.emitToUser(s.driverId, 'payroll:changed', {});
    this.tracking.emitToUser(s.driverId, 'remittance:updated', {});
    return this.one(companyId, id);
  }

  /** Export CSV de la période (comptabilité) */
  async exportCsv(companyId: string, start?: string) {
    const o = await this.overview(companyId, start);
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['Livreur', 'Période', 'Statut', 'Courses', 'Colis', 'Prix des courses', 'Brut (après primes, retenues, avances)', 'Espèces déduites', 'Net payé', 'Payé le', 'Mode', 'Référence'];
    const status = { DRAFT: 'Brouillon', PAID: 'Payée', CONFIRMED: 'Confirmée', DISPUTED: 'Contestée' };
    const rows = o.rows.map((r) => {
      const s = r.payslip;
      const e = r.estimate as { deliveries?: number; stops?: number; revenue?: number; gross?: number; cashCompensated: number; net: number } | null;
      return [r.name, o.label, s ? status[s.status] : 'Estimation', s?.deliveries ?? e?.deliveries ?? 0, s?.stops ?? e?.stops ?? 0, s?.revenue ?? e?.revenue ?? 0,
        s?.gross ?? e?.gross ?? 0, s && s.status !== 'DRAFT' ? s.cashCompensated : e?.cashCompensated ?? 0, s && s.status !== 'DRAFT' ? s.net : e?.net ?? 0,
        s?.paidAt ? new Date(s.paidAt).toLocaleDateString('fr-FR') : '', s?.method === 'MOBILE_MONEY' ? 'Mobile Money' : s?.method === 'CASH' ? 'Espèces' : '', s?.reference ?? ''];
    });
    return '﻿' + [head, ...rows].map((r) => r.map(esc).join(';')).join('\r\n');
  }

  // ---------- Avances (entreprise) ----------

  private async advanceOf(companyId: string, id: string) {
    const a = await this.advances.findOneBy({ id, companyId });
    if (!a) throw new NotFoundException('Avance introuvable');
    return a;
  }

  async approveAdvance(companyId: string, id: string, dto: { method: 'CASH' | 'MOBILE_MONEY'; reference?: string }, by: string) {
    const a = await this.advanceOf(companyId, id);
    if (a.status !== AdvanceStatus.PENDING) throw new BadRequestException('Demande déjà traitée');
    await this.advances.update(id, { status: AdvanceStatus.GIVEN, method: dto.method, reference: dto.reference?.trim() || null, decidedBy: by, decidedAt: new Date() });
    this.notify.send([a.driverId], 'CLIENT_UPDATE', { title: 'Avance accordée', body: `${money(a.amount)} versés. Retenus sur votre prochaine paie.` });
    this.tracking.emitToUser(a.driverId, 'payroll:changed', {});
    return this.overview(companyId);
  }

  async rejectAdvance(companyId: string, id: string, note: string, by: string) {
    const a = await this.advanceOf(companyId, id);
    if (a.status !== AdvanceStatus.PENDING) throw new BadRequestException('Demande déjà traitée');
    await this.advances.update(id, { status: AdvanceStatus.REJECTED, note: note.trim(), decidedBy: by, decidedAt: new Date() });
    this.notify.send([a.driverId], 'UPDATED', { title: 'Avance refusée', body: `${money(a.amount)} : « ${note.trim()} »` });
    this.tracking.emitToUser(a.driverId, 'payroll:changed', {});
    return this.overview(companyId);
  }

  /** L'entreprise enregistre une avance déjà versée */
  async recordAdvance(companyId: string, dto: { driverId: string; amount: number; method: 'CASH' | 'MOBILE_MONEY'; reason?: string; reference?: string }, by: string) {
    const d = await this.users.findOneBy({ id: dto.driverId, companyId, role: Role.DRIVER });
    if (!d) throw new NotFoundException('Livreur introuvable');
    await this.advances.save({ companyId, driverId: d.id, amount: Math.round(dto.amount), reason: dto.reason?.trim() || null, status: AdvanceStatus.GIVEN, createdBy: 'COMPANY',
      method: dto.method, reference: dto.reference?.trim() || null, decidedBy: by, decidedAt: new Date() });
    this.notify.send([d.id], 'CLIENT_UPDATE', { title: 'Avance enregistrée', body: `${money(Math.round(dto.amount))} versés par votre entreprise. Retenus sur votre prochaine paie.` });
    this.tracking.emitToUser(d.id, 'payroll:changed', {});
    return this.overview(companyId);
  }

  // ---------- Livreur ----------

  private async driverCompany(driverId: string) {
    const d = await this.users.findOne({ where: { id: driverId }, relations: { company: true } });
    if (!d?.company || d.company.independent) throw new ForbiddenException('Réservé aux livreurs des entreprises');
    return { driver: d, company: d.company };
  }

  /** Ma paye : estimation de la période en cours, fiches, avances */
  async forDriver(driverId: string) {
    const { driver, company } = await this.driverCompany(driverId);
    if (!company.payrollEnabled) return { enabled: false };
    const p = periodOf(company.payPeriod);
    const b = await this.build(company, driver, p.start, p.end, []);
    const slips = await this.slips.find({ where: { driverId, status: In([PayslipStatus.PAID, PayslipStatus.CONFIRMED, PayslipStatus.DISPUTED]) }, order: { periodStart: 'DESC' }, take: 24 });
    const advances = await this.advances.find({ where: { driverId }, order: { createdAt: 'DESC' }, take: 20 });
    return {
      enabled: true,
      companyName: company.name,
      current: { label: periodLabel(company.payPeriod, p.start, p.end), start: p.start, end: p.end, ...b.activity, lines: b.lines, gross: b.gross },
      payslips: slips.map((s) => this.view(s)),
      advances,
    };
  }

  private async driverSlip(driverId: string, id: string) {
    const s = await this.slips.findOneBy({ id, driverId });
    if (!s) throw new NotFoundException('Fiche de paie introuvable');
    if (s.status !== PayslipStatus.PAID) throw new BadRequestException('Fiche déjà confirmée ou contestée');
    return s;
  }

  async confirm(driverId: string, id: string) {
    const s = await this.driverSlip(driverId, id);
    await this.slips.update(id, { status: PayslipStatus.CONFIRMED, confirmedAt: new Date() });
    this.tracking.emitToCompany(s.companyId, 'payroll:changed', {});
    return this.forDriver(driverId);
  }

  async dispute(driverId: string, id: string, note: string) {
    const s = await this.driverSlip(driverId, id);
    await this.slips.update(id, { status: PayslipStatus.DISPUTED, disputeNote: note.trim() });
    const d = await this.users.findOneBy({ id: driverId });
    this.notify.office({ companyId: s.companyId }, 'PAYROLL', {
      title: 'Paie contestée',
      body: `${d?.name ?? 'Un livreur'} conteste sa paie (${periodLabel(s.period, s.periodStart, s.periodEnd)}) : « ${note.trim()} »`,
      link: '/paye',
    });
    this.tracking.emitToCompany(s.companyId, 'payroll:changed', {});
    return this.forDriver(driverId);
  }

  async requestAdvance(driverId: string, amount: number, reason?: string) {
    const { driver, company } = await this.driverCompany(driverId);
    if (!company.payrollEnabled) throw new BadRequestException('Votre entreprise n’utilise pas la paye VITE');
    if (await this.advances.existsBy({ driverId, status: AdvanceStatus.PENDING })) throw new BadRequestException('Une demande d’avance est déjà en attente');
    await this.advances.save({ companyId: company.id, driverId, amount: Math.round(amount), reason: reason?.trim() || null, status: AdvanceStatus.PENDING, createdBy: 'DRIVER' });
    this.notify.office({ companyId: company.id }, 'PAYROLL', { title: 'Demande d’avance', body: `${driver.name} demande ${money(Math.round(amount))}${reason?.trim() ? ` : « ${reason.trim()} »` : ''}`, link: '/paye' });
    this.tracking.emitToCompany(company.id, 'payroll:changed', {});
    return this.forDriver(driverId);
  }

  /** Paye de la période d'un livreur (fiche livreur du back-office) */
  async driverSlips(companyId: string, driverId: string) {
    return (await this.slips.find({ where: { companyId, driverId }, order: { periodStart: 'DESC' }, take: 24 })).map((s) => this.view(s));
  }
}
