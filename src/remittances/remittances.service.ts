import { NotifyService } from '../notifications/notify.service';
import { money } from '../countries/phone';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Company } from '../companies/company.entity';
import { TrackingGateway } from '../tracking/tracking.gateway';
import { Role, User } from '../users/user.entity';
import { Remittance, RemittanceStatus } from './remittance.entity';

export interface DriverCash {
  driverId: string;
  /** Livreur indépendant rattaché : il garde le prix de ses courses et ne verse que les encaissements */
  independent: boolean;
  /** Prix des courses terminées (payées en espèces au livreur) */
  earned: number;
  deliveries: number;
  /** Montants encaissés auprès des destinataires (paiement à la livraison) */
  cod: number;
  /** Part gardée par le livreur */
  share: number;
  sharePercent: number;
  confirmed: number;
  pending: number;
  /** Reste à verser à l'entreprise */
  toRemit: number;
  /** Gains de la période */
  today: number;
  week: number;
  month: number;
}

/**
 * Espèces des livreurs : ce qu'ils ont encaissé (courses + paiements à la livraison),
 * leur part (pourcentage fixé par l'entreprise) et les versements à l'entreprise.
 */
@Injectable()
export class RemittancesService {
  constructor(
    private db: DataSource,
    @InjectRepository(Remittance) private repo: Repository<Remittance>,
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(Company) private companies: Repository<Company>,
    private tracking: TrackingGateway,
    private notify: NotifyService,
  ) {}

  /** Soldes de tous les livreurs d'une entreprise (ou d'un seul) */
  async balances(companyId: string, driverId?: string): Promise<DriverCash[]> {
    const company = await this.companies.findOneBy({ id: companyId });
    const pct = company?.driverSharePercent ?? 0;
    const params: unknown[] = [companyId];
    const filter = driverId ? `AND u.id = $2` : '';
    // Livreurs de l'entreprise et ses livreurs indépendants rattachés (prix des courses : pas versé, il reste au LI)
    if (driverId) params.push(driverId);
    const rows: Record<string, number | string | boolean>[] = await this.db.query(
      `SELECT u.id AS "driverId",
              coalesce(d.earned, 0)::int AS earned, coalesce(d.deliveries, 0)::int AS deliveries,
              coalesce(d.today, 0)::int AS today, coalesce(d.week, 0)::int AS week, coalesce(d.month, 0)::int AS month,
              coalesce(c.cod, 0)::int AS cod,
              coalesce(r.confirmed, 0)::int AS confirmed, coalesce(r.pending, 0)::int AS pending,
              uc.independent
         FROM users u
         JOIN companies uc ON uc.id = u."companyId"
         LEFT JOIN (
           SELECT "driverId", sum(price) AS earned, count(*) AS deliveries,
                  sum(price) FILTER (WHERE "deliveredAt" >= date_trunc('day', now())) AS today,
                  sum(price) FILTER (WHERE "deliveredAt" >= date_trunc('week', now())) AS week,
                  sum(price) FILTER (WHERE "deliveredAt" >= date_trunc('month', now())) AS month
             FROM deliveries WHERE status = 'DELIVERED' AND "companyId" = $1 GROUP BY "driverId"
         ) d ON d."driverId" = u.id
         LEFT JOIN (
           SELECT dl."driverId", sum(s."codAmount") AS cod
             FROM delivery_stops s JOIN deliveries dl ON dl.id = s."deliveryId"
            WHERE s.status = 'DELIVERED' AND s."codAmount" > 0 AND (dl."companyId" = $1 OR dl."affiliateCompanyId" = $1) GROUP BY dl."driverId"
         ) c ON c."driverId" = u.id
         LEFT JOIN (
           SELECT "driverId", sum(amount) FILTER (WHERE status = 'CONFIRMED') AS confirmed,
                  sum(amount) FILTER (WHERE status = 'PENDING') AS pending
             FROM driver_remittances WHERE "companyId" = $1 GROUP BY "driverId"
         ) r ON r."driverId" = u.id
        WHERE u.role = 'DRIVER' ${filter}
          AND (u."companyId" = $1 OR u."companyId" IN (SELECT "companyId" FROM independent_profiles WHERE "affiliatedCompanyId" = $1))`,
      params,
    );
    return rows.map((r) => {
      const independent = r.independent === true;
      // LI : ses courses sont à son entreprise individuelle (earned = 0 ici), il ne doit que les encaissements
      const earned = independent ? 0 : Number(r.earned);
      const share = independent ? 0 : Math.round((earned * pct) / 100);
      const confirmed = Number(r.confirmed);
      return {
        driverId: String(r.driverId),
        independent,
        earned,
        deliveries: Number(r.deliveries),
        cod: Number(r.cod),
        share,
        sharePercent: independent ? 0 : pct,
        confirmed,
        pending: Number(r.pending),
        toRemit: Math.max(0, earned + Number(r.cod) - share - confirmed),
        today: Number(r.today),
        week: Number(r.week),
        month: Number(r.month),
      };
    });
  }

  /**
   * Entreprise à qui un livreur verse ses espèces : la sienne, ou celle de rattachement pour un LI
   * (null : LI non rattaché, rien à verser).
   */
  async payeeOf(driverCompanyId: string | null): Promise<{ companyId: string | null; independent: boolean }> {
    if (!driverCompanyId) return { companyId: null, independent: false };
    const c = await this.companies.findOneBy({ id: driverCompanyId });
    if (!c?.independent) return { companyId: driverCompanyId, independent: false };
    const [p] = await this.db.query(`SELECT "affiliatedCompanyId" FROM independent_profiles WHERE "companyId" = $1`, [driverCompanyId]);
    return { companyId: (p?.affiliatedCompanyId as string | null) ?? null, independent: true };
  }

  /** Vue du livreur (app) : son solde vis-à-vis de l'entreprise à qui il verse */
  async mine(driverId: string, driverCompanyId: string | null) {
    const payee = await this.payeeOf(driverCompanyId);
    if (!payee.companyId) return { balance: null, history: [], independent: payee.independent, companyName: null, codAllowed: false };
    const [{ balance, history }, company] = await Promise.all([this.forDriver(payee.companyId, driverId), this.companies.findOneBy({ id: payee.companyId })]);
    return { balance, history, independent: payee.independent, companyName: company?.name ?? null, codAllowed: company?.liCodAllowed === true };
  }

  /** Solde et historique d'un livreur */
  async forDriver(companyId: string, driverId: string) {
    const [balance] = await this.balances(companyId, driverId);
    if (!balance) throw new NotFoundException('Livreur introuvable');
    const history = await this.repo.find({ where: { driverId, companyId }, order: { createdAt: 'DESC' }, take: 200 });
    return { balance, history };
  }

  /** Vue de l'entreprise : soldes de ses livreurs et versements à confirmer */
  async forCompany(companyId: string) {
    const [balances, pending, company] = await Promise.all([
      this.balances(companyId),
      this.repo.find({ where: { companyId, status: RemittanceStatus.PENDING }, relations: { driver: true }, order: { createdAt: 'DESC' } }),
      this.companies.findOneBy({ id: companyId }),
    ]);
    return { balances, pending, sharePercent: company?.driverSharePercent ?? 0 };
  }

  /** Le livreur déclare un versement (l'entreprise confirme à réception) */
  async declare(driverId: string, companyId: string | null, dto: { amount: number; method: 'CASH' | 'MOBILE_MONEY'; reference?: string; proofUrl?: string; note?: string }) {
    const payee = await this.payeeOf(companyId);
    if (!payee.companyId) throw new BadRequestException(payee.independent ? 'Vous n’êtes rattaché à aucune entreprise' : 'Livreur sans entreprise');
    companyId = payee.companyId;
    const { balance } = await this.forDriver(companyId, driverId);
    const max = balance.toRemit - balance.pending;
    if (dto.amount > max) {
      throw new BadRequestException(
        max <= 0 ? 'Rien à verser pour le moment' : `Montant trop élevé : il vous reste ${money(max)} à verser`,
      );
    }
    const r = await this.repo.save(
      this.repo.create({ ...dto, reference: dto.reference || null, proofUrl: dto.proofUrl || null, note: dto.note || null, driverId, companyId, createdBy: 'DRIVER' }),
    );
    this.tracking.emitToCompany(companyId, 'remittance:new', { id: r.id, driverId, amount: r.amount });
    const drv = await this.users.findOneBy({ id: driverId });
    this.notify.office({ companyId }, 'REMITTANCE', {
      title: 'Versement à confirmer',
      body: `${drv?.name ?? 'Un livreur'} déclare avoir versé ${money(r.amount)}`,
      link: '/encaissements',
    });
    return r;
  }

  /** L'entreprise enregistre directement un versement reçu (confirmé) */
  async record(companyId: string, by: string, driverId: string, dto: { amount: number; method: 'CASH' | 'MOBILE_MONEY'; reference?: string; note?: string }) {
    const driver = await this.users.findOneBy({ id: driverId, role: Role.DRIVER });
    if (!driver || (await this.payeeOf(driver.companyId)).companyId !== companyId) throw new NotFoundException('Livreur introuvable');
    const r = await this.repo.save(
      this.repo.create({
        ...dto,
        reference: dto.reference || null,
        note: dto.note || null,
        driverId,
        companyId,
        createdBy: 'COMPANY',
        status: RemittanceStatus.CONFIRMED,
        reviewedBy: by,
        reviewedAt: new Date(),
      }),
    );
    this.tracking.emitToUser(driverId, 'remittance:updated', { id: r.id, status: r.status });
    return r;
  }

  async confirm(companyId: string, by: string, id: string, amount?: number) {
    const r = await this.repo.findOneBy({ id, companyId });
    if (!r) throw new NotFoundException('Versement introuvable');
    if (r.status !== RemittanceStatus.PENDING) throw new BadRequestException('Versement déjà traité');
    await this.repo.update(id, { status: RemittanceStatus.CONFIRMED, amount: amount ?? r.amount, reviewedBy: by, reviewedAt: new Date() });
    this.tracking.emitToUser(r.driverId, 'remittance:updated', { id, status: RemittanceStatus.CONFIRMED });
    return this.repo.findOne({ where: { id }, relations: { driver: true } });
  }

  async reject(companyId: string, by: string, id: string, note: string) {
    const res = await this.repo.update({ id, companyId, status: RemittanceStatus.PENDING }, { status: RemittanceStatus.REJECTED, reviewNote: note, reviewedBy: by, reviewedAt: new Date() });
    if (!res.affected) throw new BadRequestException('Versement déjà traité');
    const r = await this.repo.findOne({ where: { id }, relations: { driver: true } });
    this.tracking.emitToUser(r.driverId, 'remittance:updated', { id, status: RemittanceStatus.REJECTED });
    return r;
  }

  async setSharePercent(companyId: string, percent: number) {
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new BadRequestException('Pourcentage entre 0 et 100');
    await this.companies.update(companyId, { driverSharePercent: Math.round(percent * 10) / 10 });
    return this.forCompany(companyId);
  }
}
