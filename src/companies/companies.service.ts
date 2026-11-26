import { BillingService } from '../billing/billing.service';
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { DataSource, In, Repository } from 'typeorm';
import { computePrice, DeliverySpeed, PricingGrid, VehicleType } from '../pricing/pricing';
import { SettingsService } from '../settings/settings.service';
import { PersonDto } from '../common/dto';
import { normalizePlate, Role, User } from '../users/user.entity';
import { CreateCompanyDto } from './companies.dto';
import { Company } from './company.entity';
import { closedText, OpeningHours, openNow, validHours } from './opening';
import { TrackingGateway } from '../tracking/tracking.gateway';

@Injectable()
export class CompaniesService {
  constructor(
    private dataSource: DataSource,
    @InjectRepository(Company) private companies: Repository<Company>,
    @InjectRepository(User) private users: Repository<User>,
    private settings: SettingsService,
    private billing: BillingService,
    private tracking: TrackingGateway,
  ) {}

  // ---------- Ouverture aux commandes des clients ----------

  async availability(companyId: string) {
    const c = await this.companies.findOneBy({ id: companyId });
    if (!c) throw new BadRequestException('Entreprise introuvable');
    const open = openNow(c);
    return {
      acceptingOrders: c.acceptingOrders,
      openingHours: c.openingHours,
      openNow: open,
      status: open ? 'Ouverte aux commandes des clients' : closedText('Votre entreprise', c),
      // Réglages de LETO (lecture seule pour le gérant)
      openOrders: c.openOrders,
      liOpenOrders: c.liOpenOrders,
    };
  }

  /** Le gérant ouvre / ferme son entreprise aux commandes des clients, avec des horaires facultatifs */
  async setAvailability(companyId: string, dto: { acceptingOrders?: boolean; openingHours?: OpeningHours | null }) {
    const patch: Partial<Company> = {};
    if (typeof dto.acceptingOrders === 'boolean') patch.acceptingOrders = dto.acceptingOrders;
    if (dto.openingHours !== undefined) {
      if (dto.openingHours !== null && !validHours(dto.openingHours)) throw new BadRequestException('Horaires invalides : ouverture et fermeture (HH:MM) et au moins un jour');
      patch.openingHours = dto.openingHours ? { open: dto.openingHours.open, close: dto.openingHours.close, days: [...new Set(dto.openingHours.days)].sort() } : null;
    }
    await this.companies.update(companyId, patch);
    this.tracking.emitToCompany(companyId, 'company:availability', {});
    return this.availability(companyId);
  }

  /** SA : ses livreurs / ses livreurs indépendants voient-ils les commandes ouvertes ? */
  async setOrderAccess(id: string, dto: { openOrders?: boolean; liOpenOrders?: boolean }) {
    const patch: Partial<Company> = {};
    if (typeof dto.openOrders === 'boolean') patch.openOrders = dto.openOrders;
    if (typeof dto.liOpenOrders === 'boolean') patch.liOpenOrders = dto.liOpenOrders;
    await this.companies.update(id, patch);
    this.tracking.server?.to('drivers').emit('deliveries:changed', {});
    this.tracking.emitToCompany(id, 'company:availability', {});
    return this.companies.findOneBy({ id });
  }

  findAll(status?: string) {
    return this.companies.find({
      where: { independent: false, ...(status ? { status: status as Company['status'] } : {}) },
      order: { createdAt: 'DESC' },
    });
  }

  /** Inscription en ligne d'une entreprise : compte du gérant créé, entreprise inactive jusqu'à validation */
  async apply(dto: { name: string; phone: string; managerName: string; managerPhone: string; managerPassword: string; commune?: string; drivers?: number; vehicles?: string[]; message?: string }) {
    await this.ensurePhoneFree(dto.managerPhone);
    const company = await this.dataSource.transaction(async (m) => {
      const c = await m.save(Company, {
        name: dto.name.trim(),
        phone: dto.phone,
        active: false,
        status: 'PENDING' as const,
        vehicles: dto.vehicles?.length ? [...new Set(dto.vehicles)] : null,
        application: {
          commune: dto.commune?.trim() || undefined,
          drivers: dto.drivers,
          vehicles: dto.vehicles,
          message: dto.message?.trim() || undefined,
          managerName: dto.managerName.trim(),
          managerPhone: dto.managerPhone,
          appliedAt: new Date().toISOString(),
        },
      });
      await m.save(User, {
        name: dto.managerName.trim(),
        phone: dto.managerPhone,
        passwordHash: await bcrypt.hash(dto.managerPassword, 10),
        role: Role.COMPANY,
        companyId: c.id,
      });
      return c;
    });
    return { id: company.id, status: company.status };
  }

  /** Décision de LETO sur une demande d'inscription */
  async review(id: string, approve: boolean, note?: string) {
    const c = await this.companies.findOneBy({ id });
    if (!c || c.independent) throw new BadRequestException('Entreprise introuvable');
    if (c.status !== 'PENDING' && !(approve && c.status === 'REJECTED')) throw new BadRequestException('Demande déjà traitée');
    if (!approve && !note?.trim()) throw new BadRequestException('Motif du refus obligatoire');
    await this.companies.update(id, {
      status: approve ? 'APPROVED' : 'REJECTED',
      active: approve,
      reviewNote: approve ? null : note!.trim(),
      reviewedAt: new Date(),
      // Essai gratuit à partir de la validation (une seule fois)
      ...(approve && !c.trialEndsAt ? { trialEndsAt: this.billing.trialEndFromNow() } : {}),
    });
    return this.companies.findOneBy({ id });
  }

  /** Crée l'entreprise et le compte de son gérant dans une seule transaction */
  async create(dto: CreateCompanyDto) {
    await this.ensurePhoneFree(dto.managerPhone);
    return this.dataSource.transaction(async (m) => {
      const company = await m.save(Company, { name: dto.name, phone: dto.phone, trialEndsAt: this.billing.trialEndFromNow() });
      await m.save(User, {
        name: dto.managerName,
        phone: dto.managerPhone,
        passwordHash: await bcrypt.hash(dto.managerPassword, 10),
        role: Role.COMPANY,
        companyId: company.id,
      });
      return company;
    });
  }

  async update(id: string, dto: { name?: string; phone?: string }) {
    await this.companies.update(id, dto);
    return this.companies.findOneBy({ id });
  }

  async setActive(id: string, active: boolean) {
    await this.companies.update(id, { active });
    return this.companies.findOneBy({ id });
  }

  /** Grille de l'entreprise : sa grille propre (ou null) et la grille appliquée (fusionnée sur LETO) */
  async pricing(companyId: string) {
    const c = await this.companies.findOneBy({ id: companyId });
    const effective = this.settings.gridFor(c);
    return {
      custom: c?.pricing ?? null,
      effective,
      platform: this.settings.pricing,
      /** Engins dont l'entreprise dispose */
      vehicles: c?.vehicles ?? (Object.values(VehicleType) as string[]).filter(
        (v) => (c?.pricing as { vehicles?: Record<string, { enabled?: boolean }> } | null)?.vehicles?.[v]?.enabled !== false,
      ),
    };
  }

  /** Le gérant indique les engins dont il dispose (un engin désactivé par LETO reste non proposé) */
  async setVehicles(companyId: string, vehicles: string[]) {
    const list = [...new Set(vehicles)].filter((v) => (Object.values(VehicleType) as string[]).includes(v));
    if (!list.length) throw new BadRequestException('Choisissez au moins un engin');
    if (!list.some((v) => this.settings.pricing.vehicles[v as VehicleType].enabled)) {
      throw new BadRequestException('Aucun de ces engins n’est proposé par LETO pour le moment');
    }
    await this.companies.update(companyId, { vehicles: list });
    return this.pricing(companyId);
  }

  async setPricing(companyId: string, input: Record<string, unknown> | null) {
    const pricing = input ? this.settings.companyGrid(input as Partial<PricingGrid>) : null;
    await this.companies.update(companyId, { pricing });
    return this.pricing(companyId);
  }

  /** Entreprises actives et abonnées, avec livreurs en ligne, taux de réussite et prix indicatifs (5 km) */
  async directory() {
    const rows: { id: string; name: string; phone: string; online: number; drivers: number; delivered: number; failed: number }[] = await this.dataSource.query(
      `SELECT c.id, c.name, c.phone,
              (SELECT count(*)::int FROM users u WHERE u."companyId" = c.id AND u.role = 'DRIVER' AND u.active AND u."lastLocationAt" > now() - interval '2 minutes') AS online,
              (SELECT count(*)::int FROM users u WHERE u."companyId" = c.id AND u.role = 'DRIVER' AND u.active) AS drivers,
              (SELECT count(*)::int FROM delivery_stops s JOIN deliveries d ON d.id = s."deliveryId" WHERE d."companyId" = c.id AND s.status = 'DELIVERED') AS delivered,
              (SELECT count(*)::int FROM delivery_stops s JOIN deliveries d ON d.id = s."deliveryId" WHERE d."companyId" = c.id AND s.status = 'FAILED') AS failed
         FROM companies c
        WHERE c.active AND NOT c.independent AND c.status = 'APPROVED'
          AND (NOT $1::boolean OR c."subscriptionEndsAt" > now() OR c."trialEndsAt" > now())
        ORDER BY c.name`,
      [this.billing.config.subscriptionEnabled],
    );
    // Fermées (interrupteur ou horaires) : absentes de la liste des clients
    const companies = (await this.companies.findBy({ id: In(rows.map((r) => r.id)) })).filter((c) => openNow(c));
    return rows.filter((r) => companies.some((c) => c.id === r.id)).map((r) => {
      const grid = this.settings.gridFor(companies.find((c) => c.id === r.id));
      const handled = r.delivered + r.failed;
      return {
        ...r,
        successRate: handled ? Math.round((r.delivered / handled) * 1000) / 10 : null,
        customPricing: !!companies.find((c) => c.id === r.id)?.pricing,
        vehicles: (Object.keys(grid.vehicles) as VehicleType[])
          .filter((v) => grid.vehicles[v].enabled)
          .map((v) => ({
            vehicle: v,
            label: grid.vehicles[v].label,
            base: grid.vehicles[v].base,
            perKm: grid.vehicles[v].perKm,
            min: grid.vehicles[v].min,
            sample5km: computePrice(grid, 5, v, DeliverySpeed.STANDARD, 1, 0, { inAbidjan: true }),
            maxAbidjan: grid.vehicles[v].maxAbidjan,
          })),
        speeds: Object.fromEntries(Object.entries(grid.speeds).map(([k, s]) => [k, { label: s.label, factor: s.factor }])),
        extraStopFee: grid.extraStopFee,
      };
    });
  }

  listDrivers(companyId: string) {
    return this.users.find({
      where: { companyId, role: Role.DRIVER },
      order: { createdAt: 'DESC' },
    });
  }

  async addDriver(companyId: string, dto: PersonDto & { vehicleType?: string; plate?: string }) {
    await this.ensurePhoneFree(dto.phone);
    const driver = await this.users.save({
      name: dto.name,
      phone: dto.phone,
      passwordHash: await bcrypt.hash(dto.password, 10),
      role: Role.DRIVER,
      companyId,
      vehicleType: dto.vehicleType ?? 'MOTO',
      plate: normalizePlate(dto.plate),
    });
    delete driver.passwordHash;
    return driver;
  }

  async setDriverVehicle(companyId: string, driverId: string, vehicleType: string, plate?: string) {
    const res = await this.users.update(
      { id: driverId, companyId, role: Role.DRIVER },
      { vehicleType, ...(plate !== undefined ? { plate: normalizePlate(plate) } : {}) },
    );
    if (!res.affected) throw new BadRequestException('Livreur introuvable dans votre entreprise');
    return this.users.findOneBy({ id: driverId });
  }

  async setDriverActive(companyId: string, driverId: string, active: boolean) {
    await this.users.update({ id: driverId, companyId, role: Role.DRIVER }, { active });
    return this.users.findOneBy({ id: driverId, companyId });
  }

  private async ensurePhoneFree(phone: string) {
    if (await this.users.existsBy({ phone })) {
      throw new ConflictException('Ce numéro est déjà utilisé');
    }
  }
}
