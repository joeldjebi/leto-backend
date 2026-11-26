import { IsPhone, PHONE_MESSAGE } from '../countries/phone';
import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsBoolean, IsEnum, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';
import type { Response } from 'express';
import { existsSync } from 'fs';
import { Repository } from 'typeorm';
import { AuthService } from '../auth/auth.service';
import { AuthUser, CurrentUser, Public, Roles } from '../common/decorators';
import {PersonDto} from '../common/dto';
import { VehicleType } from '../pricing/pricing';
import { StorageService } from '../storage/storage.service';
import { Role, User } from '../users/user.entity';
import { IndependentStatus, RENEWABLE, RenewableField } from './independent-profile.entity';
import { IndependentsService } from './independents.service';

const SELFIE = /^\/uploads\/[0-9a-f-]{36}\.(jpg|png|webp|heic)$/;
const DOC = /^\/identity\/[0-9a-f-]{36}\.(jpg|png|webp|heic)$/;
const DOC_MSG = 'Photo invalide : prenez-la avec l’appareil photo de l’app';
const DATE = /^\d{4}-\d{2}-\d{2}$/;

class DossierDto {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Date de naissance : AAAA-MM-JJ' }) birthDate?: string;
  @IsOptional() @IsString() @MaxLength(40) commune?: string;
  @IsOptional() @IsString() @MaxLength(150) address?: string;
  @IsOptional() @IsIn(['CNI', 'PASSPORT', 'CONSULAR', 'RESIDENCE'], { message: 'Type de pièce inconnu' }) idType?: string;
  @IsOptional() @IsString() @MaxLength(40) idNumber?: string;
  @IsOptional() @IsString() @MaxLength(100) emergencyName?: string;
  @IsPhone({ optional: true, message: `Contact d’urgence : ${PHONE_MESSAGE}` }) emergencyPhone?: string;
  @IsOptional() @IsEnum(VehicleType, { message: 'Engin : moto, voiture ou cargo' }) vehicleType?: string;
  @IsOptional() @IsString() @MaxLength(60) vehicleBrand?: string;
  @IsOptional() @IsString() @MaxLength(20) vehiclePlate?: string;
  @IsOptional() @IsString() @MaxLength(40) licenseNumber?: string;
  @IsOptional() @Matches(SELFIE, { message: 'Selfie invalide : prenez-le avec l’appareil photo de l’app' }) selfieUrl?: string;
  @IsOptional() @Matches(DOC, { message: DOC_MSG }) docsSelfieUrl?: string;
  @IsOptional() @Matches(DOC, { message: DOC_MSG }) idFrontUrl?: string;
  @IsOptional() @Matches(DOC, { message: DOC_MSG }) idBackUrl?: string;
  @IsOptional() @Matches(DOC, { message: DOC_MSG }) licenseUrl?: string;
  @IsOptional() @Matches(DOC, { message: DOC_MSG }) registrationUrl?: string;
  @IsOptional() @Matches(DOC, { message: DOC_MSG }) insuranceUrl?: string;
  @IsOptional() @Matches(DATE, { message: 'Fin de validité du permis : AAAA-MM-JJ' }) licenseExpiresOn?: string;
  @IsOptional() @Matches(DATE, { message: 'Fin de validité de l’assurance : AAAA-MM-JJ' }) insuranceExpiresOn?: string;
  @IsOptional() @IsBoolean() consent?: boolean;
}

class RenewalDto {
  @IsIn(RENEWABLE as unknown as string[], { message: 'Document inconnu' }) field: RenewableField;
  @IsOptional() @Matches(DOC, { message: DOC_MSG }) url?: string;
  @IsOptional() @Matches(DATE, { message: 'Date de fin de validité : AAAA-MM-JJ' }) expiresOn?: string;
}

class ExpiryDto {
  @IsOptional() @ValidateIf((_, v) => v !== null) @Matches(DATE, { message: 'Permis : AAAA-MM-JJ' }) licenseExpiresOn?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @Matches(DATE, { message: 'Assurance : AAAA-MM-JJ' }) insuranceExpiresOn?: string | null;
}

class ConfigDto {
  @IsOptional() @IsBoolean() registrationOpen?: boolean;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsIn(['PERCENT', 'FIXED']) commissionType?: 'PERCENT' | 'FIXED';
  @IsOptional() @IsNumber() commissionValue?: number;
  @IsOptional() @IsNumber() companyMaxPct?: number;
  @IsOptional() @IsNumber() companyMaxFixed?: number;
  @IsOptional() @IsNumber() transitionDays?: number;
  @IsOptional() @IsNumber() earningsHoldHours?: number;
  @IsOptional() @IsNumber() minWithdrawal?: number;
}

class NoteDto {
  @IsString() @IsNotEmpty({ message: 'Motif obligatoire' }) @MaxLength(500) note: string;
}

class ListQuery {
  @IsOptional() @IsEnum(IndependentStatus) status?: IndependentStatus;
}

/** Livreurs indépendants : inscription, dossier, validation par LETO */
@Controller('independents')
export class IndependentsController {
  constructor(
    private service: IndependentsService,
    private auth: AuthService,
    @InjectRepository(User) private users: Repository<User>,
  ) {}

  private async by(user: AuthUser) {
    return (await this.users.findOneBy({ id: user.sub }))?.name ?? 'LETO';
  }

  // ----- Public / app -----
  @Public()
  @Get('public')
  info() {
    return this.service.publicInfo();
  }

  @Public()
  @Post('register')
  async register(@Body() dto: PersonDto) {
    return this.auth.session(await this.service.register(dto));
  }

  @Get('me')
  @Roles(Role.DRIVER)
  me(@CurrentUser() user: AuthUser) {
    return this.service.me(user.sub);
  }

  @Put('me')
  @Roles(Role.DRIVER)
  update(@CurrentUser() user: AuthUser, @Body() dto: DossierDto) {
    return this.service.update(user.sub, dto);
  }

  @Post('me/renewals')
  @Roles(Role.DRIVER)
  renew(@CurrentUser() user: AuthUser, @Body() dto: RenewalDto) {
    return this.service.submitRenewal(user.sub, dto);
  }

  @Post('me/submit')
  @Roles(Role.DRIVER)
  submit(@CurrentUser() user: AuthUser) {
    return this.service.submit(user.sub);
  }

  // ----- Super Admin -----
  @Get()
  @Roles(Role.SUPER_ADMIN)
  list(@Query() q: ListQuery) {
    return this.service.list(q.status);
  }

  @Get('config')
  @Roles(Role.SUPER_ADMIN)
  config() {
    return this.service.config;
  }

  @Put('config')
  @Roles(Role.SUPER_ADMIN)
  async setConfig(@CurrentUser() user: AuthUser, @Body() dto: ConfigDto) {
    return this.service.updateConfig(dto, await this.by(user));
  }

  @Get(':id')
  @Roles(Role.SUPER_ADMIN)
  one(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.one(id);
  }

  @Post(':id/approve')
  @Roles(Role.SUPER_ADMIN)
  async approve(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.approve(id, await this.by(user));
  }

  @Post(':id/reject')
  @Roles(Role.SUPER_ADMIN)
  async reject(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: NoteDto) {
    return this.service.reject(id, await this.by(user), dto.note);
  }

  @Post(':id/suspend')
  @Roles(Role.SUPER_ADMIN)
  async suspend(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: NoteDto) {
    return this.service.suspend(id, await this.by(user), dto.note);
  }

  @Post(':id/renewals/:renewalId/approve')
  @Roles(Role.SUPER_ADMIN)
  async approveRenewal(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('renewalId', ParseUUIDPipe) rid: string) {
    return this.service.approveRenewal(id, rid, await this.by(user));
  }

  @Post(':id/renewals/:renewalId/reject')
  @Roles(Role.SUPER_ADMIN)
  async rejectRenewal(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('renewalId', ParseUUIDPipe) rid: string, @Body() dto: NoteDto) {
    return this.service.rejectRenewal(id, rid, await this.by(user), dto.note);
  }

  @Put(':id/expiry')
  @Roles(Role.SUPER_ADMIN)
  async expiry(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ExpiryDto) {
    return this.service.setExpiry(id, dto, await this.by(user));
  }

  @Post(':id/reactivate')
  @Roles(Role.SUPER_ADMIN)
  async reactivate(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.reactivate(id, await this.by(user));
  }
}

/** Lecture des pièces d'identité : uniquement avec un lien signé et temporaire (15 min) */
@Controller('identity')
export class IdentityFilesController {
  constructor(private service: IndependentsService, private storage: StorageService) {}

  @Public()
  @Get(':name')
  async read(@Param('name') name: string, @Query('exp') exp: string, @Query('sig') sig: string, @Res() res: Response) {
    if (!/^[0-9a-f-]{36}\.(jpg|png|webp|heic)$/.test(name) || !this.service.verify(name, exp, sig)) throw new NotFoundException();
    res.setHeader('Cache-Control', 'private, no-store');
    const path = this.storage.localPath(name, 'identity');
    if (existsSync(path)) return res.sendFile(path);
    if (!this.storage.usesWasabi) throw new NotFoundException();
    return res.redirect(302, await this.storage.signedUrl(name, 'identity', 300));
  }
}

