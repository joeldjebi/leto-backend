import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { DataSource, In, Repository } from 'typeorm';
import { computePrice, DeliverySpeed, PricingGrid, VehicleType } from '../pricing/pricing';
import { SettingsService } from '../settings/settings.service';
import { PersonDto } from '../common/dto';
import { Role, User } from '../users/user.entity';
import { CreateCompanyDto } from './companies.dto';
import { Company } from './company.entity';

@Injectable()
export class CompaniesService {
  constructor(
    private dataSource: DataSource,
    @InjectRepository(Company) private companies: Repository<Company>,
    @InjectRepository(User) private users: Repository<User>,
    private settings: SettingsService,
  ) {}

  findAll() {
    return this.companies.find({ order: { createdAt: 'DESC' } });
  }

  /** Crée l'entreprise et le compte de son gérant dans une seule transaction */
  async create(dto: CreateCompanyDto) {
    await this.ensurePhoneFree(dto.managerPhone);
    return this.dataSource.transaction(async (m) => {
      const company = await m.save(Company, { name: dto.name, phone: dto.phone });
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
        WHERE c.active AND c."subscriptionEndsAt" > now()
        ORDER BY c.name`,
    );
    const companies = await this.companies.findBy({ id: In(rows.map((r) => r.id)) });
    return rows.map((r) => {
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

  async addDriver(companyId: string, dto: PersonDto) {
    await this.ensurePhoneFree(dto.phone);
    const driver = await this.users.save({
      name: dto.name,
      phone: dto.phone,
      passwordHash: await bcrypt.hash(dto.password, 10),
      role: Role.DRIVER,
      companyId,
    });
    delete driver.passwordHash;
    return driver;
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
