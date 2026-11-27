import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, Injectable, Logger, NotFoundException,
  OnModuleInit, Param, ParseUUIDPipe, Patch, Post,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import { DataSource, Repository } from 'typeorm';
import { Public, Roles } from '../common/decorators';
import { TrackingGateway } from '../tracking/tracking.gateway';
import { Role } from '../users/user.entity';
import { Country } from './country.entity';
import { Countries, flagOf } from './phone';

export class CountryDto {
  @IsOptional() @Matches(/^[A-Za-z]{2}$/, { message: 'Code ISO : 2 lettres (ex. CI)' }) iso?: string;
  @IsOptional() @IsString() @Length(2, 60, { message: 'Nom : 2 à 60 caractères' }) name?: string;
  @IsOptional() @Matches(/^\d{1,4}$/, { message: 'Indicatif : 1 à 4 chiffres, sans « + »' }) dialCode?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(4, { message: 'Longueur du numéro : 4 à 14 chiffres' }) @Max(14, { message: 'Longueur du numéro : 4 à 14 chiffres' }) phoneLength?: number;
  @IsOptional() @Matches(/^\d{0,2}$/, { message: 'Préfixe national : 0 à 2 chiffres' }) trunkPrefix?: string;
  @IsOptional() @Matches(/^[\d ]{0,20}$/, { message: 'Exemple : chiffres uniquement' }) phoneExample?: string;
  @IsOptional() @Matches(/^[A-Za-z]{3}$/, { message: 'Code devise : 3 lettres (ex. XOF)' }) currencyCode?: string;
  @IsOptional() @IsString() @Length(1, 8, { message: 'Symbole : 1 à 8 caractères' }) currencySymbol?: string;
  @IsOptional() @IsString() @MaxLength(40) currencyName?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(3) currencyDecimals?: number;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsBoolean() operating?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(9999) sortOrder?: number;
}

type Seed = Omit<Country, 'id' | 'createdAt' | 'updatedAt'>;
const xof = { currencyCode: 'XOF', currencySymbol: 'F', currencyName: 'Franc CFA (BCEAO)', currencyDecimals: 0 };
/** Côte d'Ivoire active ; les autres pays sont prêts à être activés */
const SEED: Seed[] = [
  { iso: 'CI', name: 'Côte d’Ivoire', dialCode: '225', phoneLength: 10, trunkPrefix: '', phoneExample: '07 01 02 03 04', ...xof, active: true, operating: true, sortOrder: 1 },
  { iso: 'SN', name: 'Sénégal', dialCode: '221', phoneLength: 9, trunkPrefix: '', phoneExample: '77 123 45 67', ...xof, active: false, operating: false, sortOrder: 10 },
  { iso: 'ML', name: 'Mali', dialCode: '223', phoneLength: 8, trunkPrefix: '', phoneExample: '65 01 23 45', ...xof, active: false, operating: false, sortOrder: 10 },
  { iso: 'BF', name: 'Burkina Faso', dialCode: '226', phoneLength: 8, trunkPrefix: '', phoneExample: '70 12 34 56', ...xof, active: false, operating: false, sortOrder: 10 },
  { iso: 'BJ', name: 'Bénin', dialCode: '229', phoneLength: 10, trunkPrefix: '', phoneExample: '01 97 12 34 56', ...xof, active: false, operating: false, sortOrder: 10 },
  { iso: 'TG', name: 'Togo', dialCode: '228', phoneLength: 8, trunkPrefix: '', phoneExample: '90 12 34 56', ...xof, active: false, operating: false, sortOrder: 10 },
  { iso: 'NE', name: 'Niger', dialCode: '227', phoneLength: 8, trunkPrefix: '', phoneExample: '93 12 34 56', ...xof, active: false, operating: false, sortOrder: 10 },
  { iso: 'GW', name: 'Guinée-Bissau', dialCode: '245', phoneLength: 9, trunkPrefix: '', phoneExample: '955 012 345', ...xof, active: false, operating: false, sortOrder: 10 },
  { iso: 'GN', name: 'Guinée', dialCode: '224', phoneLength: 9, trunkPrefix: '', phoneExample: '621 23 45 67', currencyCode: 'GNF', currencySymbol: 'FG', currencyName: 'Franc guinéen', currencyDecimals: 0, active: false, operating: false, sortOrder: 20 },
  { iso: 'GH', name: 'Ghana', dialCode: '233', phoneLength: 9, trunkPrefix: '0', phoneExample: '024 123 4567', currencyCode: 'GHS', currencySymbol: '₵', currencyName: 'Cedi', currencyDecimals: 2, active: false, operating: false, sortOrder: 20 },
  { iso: 'LR', name: 'Liberia', dialCode: '231', phoneLength: 9, trunkPrefix: '0', phoneExample: '077 012 3456', currencyCode: 'LRD', currencySymbol: 'L$', currencyName: 'Dollar libérien', currencyDecimals: 2, active: false, operating: false, sortOrder: 20 },
  { iso: 'NG', name: 'Nigeria', dialCode: '234', phoneLength: 10, trunkPrefix: '0', phoneExample: '0803 123 4567', currencyCode: 'NGN', currencySymbol: '₦', currencyName: 'Naira', currencyDecimals: 2, active: false, operating: false, sortOrder: 20 },
  { iso: 'CM', name: 'Cameroun', dialCode: '237', phoneLength: 9, trunkPrefix: '', phoneExample: '6 71 23 45 67', currencyCode: 'XAF', currencySymbol: 'FCFA', currencyName: 'Franc CFA (BEAC)', currencyDecimals: 0, active: false, operating: false, sortOrder: 20 },
  { iso: 'FR', name: 'France', dialCode: '33', phoneLength: 9, trunkPrefix: '0', phoneExample: '06 12 34 56 78', currencyCode: 'EUR', currencySymbol: '€', currencyName: 'Euro', currencyDecimals: 2, active: false, operating: false, sortOrder: 30 },
];

/** Colonnes de numéros converties au format international (ancien format : 10 chiffres ivoiriens) */
const PHONE_COLUMNS: [string, string][] = [
  ['users', 'phone'],
  ['companies', 'phone'],
  ['deliveries', 'pickupPhone'],
  ['delivery_stops', 'recipientPhone'],
  ['logbook_entries', 'recipientPhone'],
  ['saved_addresses', 'recipientPhone'],
  ['independent_profiles', 'emergencyPhone'],
  ['payments', 'senderPhone'],
];

const view = (c: Country) => ({
  id: c.id, iso: c.iso, name: c.name, flag: flagOf(c.iso), dialCode: c.dialCode, phoneLength: c.phoneLength,
  trunkPrefix: c.trunkPrefix, phoneExample: c.phoneExample, currencyCode: c.currencyCode, currencySymbol: c.currencySymbol,
  currencyName: c.currencyName, currencyDecimals: c.currencyDecimals, active: c.active, operating: c.operating, sortOrder: c.sortOrder,
});

@Injectable()
export class CountriesService implements OnModuleInit {
  private logger = new Logger('Countries');
  constructor(
    @InjectRepository(Country) private repo: Repository<Country>,
    private data: DataSource,
    private tracking: TrackingGateway,
  ) {}

  async onModuleInit() {
    if ((await this.repo.count()) === 0) {
      await this.repo.save(SEED.map((s) => this.repo.create(s)));
      this.logger.log(`${SEED.length} pays créés (Côte d’Ivoire active)`);
    }
    await this.refresh();
    await this.migratePhones();
  }

  /** Ancien format (0701020304) → +2250701020304 ; sans effet s'il n'y a plus rien à convertir */
  private async migratePhones() {
    for (const [table, col] of PHONE_COLUMNS) {
      const r = await this.data.query(
        `UPDATE "${table}" SET "${col}" = '+225' || "${col}" WHERE "${col}" ~ '^0[0-9]{9}$'`,
      );
      const n = Array.isArray(r) ? r[1] : 0;
      if (n) this.logger.log(`${table}.${col} : ${n} numéro(s) convertis au format international`);
    }
    // Numéro du gérant dans les demandes d'inscription des entreprises
    await this.data.query(
      `UPDATE "companies" SET "application" = jsonb_set("application", '{managerPhone}', to_jsonb('+225' || ("application"->>'managerPhone')))
       WHERE "application" ? 'managerPhone' AND ("application"->>'managerPhone') ~ '^0[0-9]{9}$'`,
    ).catch(() => undefined);
  }

  private async refresh() {
    const all = await this.repo.find({ order: { sortOrder: 'ASC', name: 'ASC' } });
    Countries.list = all.map((c) => ({
      iso: c.iso, name: c.name, dialCode: c.dialCode, phoneLength: c.phoneLength, trunkPrefix: c.trunkPrefix,
      currencyCode: c.currencyCode, currencySymbol: c.currencySymbol, currencyDecimals: c.currencyDecimals,
      active: c.active, operating: c.operating,
    }));
    return all;
  }

  async publicList() {
    const all = await this.repo.find({ where: { active: true }, order: { sortOrder: 'ASC', name: 'ASC' } });
    return { operating: Countries.operating.iso, countries: all.map(view) };
  }

  async adminList() {
    const all = await this.repo.find({ order: { sortOrder: 'ASC', name: 'ASC' } });
    return { operating: Countries.operating.iso, countries: all.map(view) };
  }

  private async check(c: Country, id?: string) {
    const dup = await this.repo.findOneBy({ iso: c.iso });
    if (dup && dup.id !== id) throw new ConflictException(`Le pays ${c.iso} existe déjà`);
    const sameDial = await this.repo.findOneBy({ dialCode: c.dialCode });
    if (sameDial && sameDial.id !== id) throw new ConflictException(`L’indicatif +${c.dialCode} est déjà utilisé par ${sameDial.name}`);
    if (c.operating && !c.active) throw new BadRequestException('Le pays où VITE livre doit rester actif');
    if (c.phoneExample) {
      const digits = c.phoneExample.replace(/\D/g, '');
      const ok = digits.length === c.phoneLength || (c.trunkPrefix && digits.length === c.phoneLength + c.trunkPrefix.length && digits.startsWith(c.trunkPrefix));
      if (!ok) throw new BadRequestException(`L’exemple doit compter ${c.phoneLength} chiffres${c.trunkPrefix ? ` (ou ${c.trunkPrefix} + ${c.phoneLength})` : ''}`);
    }
  }

  private async saveAndBroadcast(c: Country) {
    const saved = await this.data.transaction(async (m) => {
      const s = await m.save(Country, c);
      // Un seul pays « où VITE livre »
      if (s.operating) await m.createQueryBuilder().update(Country).set({ operating: false }).where('id != :id', { id: s.id }).execute();
      return s;
    });
    await this.refresh();
    this.tracking.server?.emit('countries:changed', {});
    return view(saved);
  }

  async create(dto: CountryDto) {
    for (const k of ['iso', 'name', 'dialCode', 'phoneLength', 'currencyCode', 'currencySymbol'] as const)
      if (dto[k] === undefined || dto[k] === '') throw new BadRequestException('Code ISO, nom, indicatif, longueur du numéro, devise et symbole sont obligatoires');
    const c = this.repo.create({
      ...dto,
      iso: dto.iso!.toUpperCase(),
      currencyCode: dto.currencyCode!.toUpperCase(),
      name: dto.name!.trim(),
      trunkPrefix: dto.trunkPrefix ?? '',
      phoneExample: dto.phoneExample?.trim() ?? '',
      currencyName: dto.currencyName?.trim() ?? '',
      active: dto.active ?? true,
      operating: dto.operating ?? false,
    });
    await this.check(c);
    return this.saveAndBroadcast(c);
  }

  async update(id: string, dto: CountryDto) {
    const c = await this.repo.findOneBy({ id });
    if (!c) throw new NotFoundException('Pays introuvable');
    const wasOperating = c.operating;
    const before = { dial: c.dialCode, len: c.phoneLength, trunk: c.trunkPrefix };
    if (wasOperating && dto.operating === false) throw new BadRequestException('Choisissez d’abord un autre pays où VITE livre');
    Object.assign(c, Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined)));
    c.iso = c.iso.toUpperCase();
    c.currencyCode = c.currencyCode.toUpperCase();
    c.name = c.name.trim();
    // Les numéros déjà enregistrés dépendent de l'indicatif et de la longueur
    if (c.dialCode !== before.dial || c.phoneLength !== before.len) {
      const used = await this.usersWithDial(before.dial);
      if (used) throw new BadRequestException(`${used} compte(s) utilisent l’indicatif +${before.dial} : indicatif et longueur du numéro ne peuvent plus être modifiés`);
    }
    await this.check(c, id);
    return this.saveAndBroadcast(c);
  }

  private async usersWithDial(dial: string) {
    const r = await this.data.query(`SELECT COUNT(*)::int AS n FROM "users" WHERE "phone" LIKE $1`, [`+${dial}%`]);
    return r[0]?.n ?? 0;
  }

  async remove(id: string) {
    const c = await this.repo.findOneBy({ id });
    if (!c) throw new NotFoundException('Pays introuvable');
    if (c.operating) throw new BadRequestException('Impossible de supprimer le pays où VITE livre');
    const used = await this.usersWithDial(c.dialCode);
    if (used) throw new BadRequestException(`${used} compte(s) utilisent l’indicatif +${c.dialCode} : désactivez le pays plutôt que de le supprimer`);
    await this.repo.delete(id);
    await this.refresh();
    this.tracking.server?.emit('countries:changed', {});
    return { ok: true };
  }
}

@Controller()
export class CountriesController {
  constructor(private service: CountriesService) {}

  /** Pays actifs (sélecteurs d'indicatif, devise) : public pour les écrans d'inscription */
  @Public()
  @Get('countries')
  list() {
    return this.service.publicList();
  }

  @Roles(Role.SUPER_ADMIN)
  @Get('admin/countries')
  adminList() {
    return this.service.adminList();
  }

  @Roles(Role.SUPER_ADMIN)
  @Post('admin/countries')
  create(@Body() dto: CountryDto) {
    return this.service.create(dto);
  }

  @Roles(Role.SUPER_ADMIN)
  @Patch('admin/countries/:id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CountryDto) {
    return this.service.update(id, dto);
  }

  @Roles(Role.SUPER_ADMIN)
  @Delete('admin/countries/:id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(id);
  }
}
