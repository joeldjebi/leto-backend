import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsLatitude, IsLongitude, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { Between, FindOptionsWhere, Repository } from 'typeorm';
import { AuthUser, CurrentUser, Roles } from '../common/decorators';
import { PHONE_MESSAGE, PHONE_REGEX } from '../common/dto';
import { TrackingGateway } from '../tracking/tracking.gateway';
import { Role, User } from '../users/user.entity';
import { LogbookEntry, LogbookEvent, LogbookStatus } from './logbook-entry.entity';

const PHOTO = /^\/uploads\/[\w.-]+$/;

class CreateEntryDto {
  @IsString() @IsNotEmpty({ message: 'Adresse obligatoire' }) @MaxLength(200) address: string;
  @IsOptional() @IsLatitude() lat?: number;
  @IsOptional() @IsLongitude() lng?: number;
  @IsOptional() @IsString() @MaxLength(100) recipientName?: string;
  @Matches(PHONE_REGEX, { message: PHONE_MESSAGE }) recipientPhone: string;
  @Type(() => Number) @IsInt({ message: 'Prix entier attendu' }) @Min(0) @Max(1_000_000) price: number;
  @Matches(PHOTO, { message: 'Photo du colis obligatoire' }) photoUrl: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

class UpdateEntryDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(200) address?: string;
  @IsOptional() @IsString() @MaxLength(100) recipientName?: string;
  @IsOptional() @Matches(PHONE_REGEX, { message: PHONE_MESSAGE }) recipientPhone?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(1_000_000) price?: number;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

class StatusDto {
  @IsEnum(LogbookStatus) status: LogbookStatus;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

class ListQuery {
  @IsOptional() @IsUUID() driverId?: string;
  @IsOptional() @IsUUID() companyId?: string;
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
}

/** Carnet des livreurs : livraisons saisies par le livreur lui-même, consultables par son entreprise */
@Controller('logbook')
export class LogbookController {
  constructor(
    @InjectRepository(LogbookEntry) private repo: Repository<LogbookEntry>,
    @InjectRepository(User) private users: Repository<User>,
    private tracking: TrackingGateway,
  ) {}

  private changed(e: LogbookEntry) {
    if (e.companyId) this.tracking.emitToCompany(e.companyId, 'logbook:changed', { id: e.id, driverId: e.driverId });
    return e;
  }

  private async mine(user: AuthUser, id: string) {
    const e = await this.repo.findOneBy({ id, driverId: user.sub });
    if (!e) throw new NotFoundException('Livraison introuvable');
    return e;
  }

  private list(where: FindOptionsWhere<LogbookEntry>, q: ListQuery) {
    const from = q.from ? new Date(q.from) : new Date(Date.now() - 90 * 86400_000);
    const to = q.to ? new Date(q.to) : new Date(Date.now() + 86400_000);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) throw new BadRequestException('Dates invalides');
    return this.repo.find({
      where: { ...where, createdAt: Between(from, to) },
      relations: { driver: true },
      order: { createdAt: 'DESC' },
      take: 2000,
    });
  }

  // ----- Livreur -----
  @Get('me')
  @Roles(Role.DRIVER)
  me(@CurrentUser() user: AuthUser, @Query() q: ListQuery) {
    return this.list({ driverId: user.sub }, q);
  }

  @Post()
  @Roles(Role.DRIVER)
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateEntryDto) {
    const driver = await this.users.findOneBy({ id: user.sub });
    const e = await this.repo.save(
      this.repo.create({
        ...dto,
        lat: dto.lat ?? null,
        lng: dto.lng ?? null,
        recipientName: dto.recipientName?.trim() || null,
        note: dto.note?.trim() || null,
        driverId: user.sub,
        companyId: driver?.companyId ?? null,
        history: [{ at: new Date().toISOString(), action: 'CREATED' }],
      }),
    );
    return this.changed(e);
  }

  @Patch(':id')
  @Roles(Role.DRIVER)
  async update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateEntryDto) {
    const e = await this.mine(user, id);
    const changes: LogbookEvent['changes'] = {};
    for (const k of ['address', 'recipientName', 'recipientPhone', 'price', 'note'] as const) {
      const to = dto[k] === undefined ? undefined : typeof dto[k] === 'string' ? (dto[k] as string).trim() || null : dto[k];
      if (to !== undefined && to !== e[k]) {
        changes[k] = { from: e[k], to };
        (e as unknown as Record<string, unknown>)[k] = to;
      }
    }
    if (!Object.keys(changes).length) return e;
    e.history = [...e.history, { at: new Date().toISOString(), action: 'UPDATED', changes }];
    return this.changed(await this.repo.save(e));
  }

  @Post(':id/status')
  @Roles(Role.DRIVER)
  async status(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: StatusDto) {
    const e = await this.mine(user, id);
    if (e.status === dto.status) return e;
    e.status = dto.status;
    e.doneAt = dto.status === LogbookStatus.TODO ? null : new Date();
    e.history = [...e.history, { at: new Date().toISOString(), action: 'STATUS', status: dto.status, note: dto.note?.trim() || undefined }];
    return this.changed(await this.repo.save(e));
  }

  // ----- Entreprise / super admin -----
  @Get('company')
  @Roles(Role.COMPANY)
  company(@CurrentUser() user: AuthUser, @Query() q: ListQuery) {
    return this.list({ companyId: user.companyId, ...(q.driverId ? { driverId: q.driverId } : {}) }, q);
  }

  @Get()
  @Roles(Role.SUPER_ADMIN)
  all(@Query() q: ListQuery) {
    return this.list({ ...(q.companyId ? { companyId: q.companyId } : {}), ...(q.driverId ? { driverId: q.driverId } : {}) }, q);
  }
}
