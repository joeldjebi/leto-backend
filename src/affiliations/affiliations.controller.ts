import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Matches, MaxLength, Min } from 'class-validator';
import { Repository } from 'typeorm';
import { AuthUser, CurrentUser, Roles } from '../common/decorators';
import { IsPhone, PHONE_MESSAGE } from '../countries/phone';
import { Role, User } from '../users/user.entity';
import { RENEWABLE, RenewableField } from '../independents/independent-profile.entity';
import { WithdrawalStatus } from './affiliation.entities';
import { AffiliationsService } from './affiliations.service';

class RateDto {
  @IsIn(['PERCENT', 'FIXED'], { message: 'Commission : pourcentage ou montant fixe' }) type: 'PERCENT' | 'FIXED';
  @Type(() => Number) @IsNumber({}, { message: 'Montant de la commission attendu' }) @Min(0) value: number;
}
class ProposeDto {
  @IsUUID() profileId: string;
  @IsUUID() companyId: string;
}
class CodDto {
  @IsBoolean() allowed: boolean;
}
class InviteDto {
  @IsUUID() profileId: string;
  @IsOptional() @IsString() @MaxLength(300) message?: string;
}
class ReasonDto {
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}
class UpdateRequestDto {
  @IsIn(RENEWABLE as unknown as string[], { message: 'Document inconnu' }) field: RenewableField;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}
class WithdrawDto {
  @Type(() => Number) @IsInt({ message: 'Montant entier attendu' }) @Min(1) amount: number;
  @IsString() @IsNotEmpty({ message: 'Opérateur obligatoire' }) @MaxLength(40) operator: string;
  @IsPhone({ message: PHONE_MESSAGE }) phone: string;
}
class TransferDto {
  @Type(() => Number) @IsInt({ message: 'Montant entier attendu' }) @Min(1) amount: number;
}
class PayDto {
  @IsOptional() @Matches(/^\/uploads\/[\w.-]+$/) proofUrl?: string;
  @IsOptional() @IsString() @MaxLength(100) reference?: string;
}
class NoteDto {
  @IsString() @IsNotEmpty({ message: 'Motif obligatoire' }) @MaxLength(300) note: string;
}

@Controller('affiliations')
export class AffiliationsController {
  constructor(
    private service: AffiliationsService,
    @InjectRepository(User) private users: Repository<User>,
  ) {}

  private async nameOf(user: AuthUser) {
    return (await this.users.findOneBy({ id: user.sub }))?.name ?? user.role;
  }

  // ----- Entreprise -----
  @Get('company')
  @Roles(Role.COMPANY)
  company(@CurrentUser() user: AuthUser) {
    return this.service.forCompany(user.companyId);
  }

  @Get('company/pool-news')
  @Roles(Role.COMPANY)
  poolNews(@CurrentUser() user: AuthUser) {
    return this.service.poolNews(user.companyId);
  }

  @Post('company/pool-seen')
  @Roles(Role.COMPANY)
  poolSeen(@CurrentUser() user: AuthUser) {
    return this.service.poolSeen(user.companyId);
  }

  @Put('company/rate')
  @Roles(Role.COMPANY)
  async rate(@CurrentUser() user: AuthUser, @Body() dto: RateDto) {
    return this.service.setRate(user.companyId, dto.type, dto.value, await this.nameOf(user));
  }

  @Put('company/cod')
  @Roles(Role.COMPANY)
  cod(@CurrentUser() user: AuthUser, @Body() dto: CodDto) {
    return this.service.setCod(user.companyId, dto.allowed);
  }

  @Post('invites')
  @Roles(Role.COMPANY)
  async invite(@CurrentUser() user: AuthUser, @Body() dto: InviteDto) {
    return this.service.invite(user.companyId, dto.profileId, dto.message, await this.nameOf(user));
  }

  @Post('invites/:id/cancel')
  @Roles(Role.COMPANY)
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.cancelInvite(user.companyId, id);
  }

  @Post('drivers/:profileId/end')
  @Roles(Role.COMPANY)
  async end(@CurrentUser() user: AuthUser, @Param('profileId', ParseUUIDPipe) profileId: string, @Body() dto: ReasonDto) {
    await this.service.end(profileId, { companyId: user.companyId, name: await this.nameOf(user) }, dto.reason);
    return this.service.forCompany(user.companyId);
  }

  @Get('drivers/:profileId/dossier')
  @Roles(Role.COMPANY)
  async dossier(@CurrentUser() user: AuthUser, @Param('profileId', ParseUUIDPipe) profileId: string) {
    return this.service.dossier(user.companyId, profileId, await this.nameOf(user));
  }

  @Post('drivers/:profileId/request-update')
  @Roles(Role.COMPANY)
  async requestUpdate(@CurrentUser() user: AuthUser, @Param('profileId', ParseUUIDPipe) profileId: string, @Body() dto: UpdateRequestDto) {
    return this.service.requestUpdate(user.companyId, profileId, dto.field, dto.note, await this.nameOf(user));
  }

  @Get('earnings')
  @Roles(Role.COMPANY)
  earnings(@CurrentUser() user: AuthUser) {
    return this.service.earningsOf(user.companyId);
  }

  @Post('withdrawals')
  @Roles(Role.COMPANY)
  async withdraw(@CurrentUser() user: AuthUser, @Body() dto: WithdrawDto) {
    return this.service.requestWithdrawal(user.companyId, dto, await this.nameOf(user));
  }

  @Post('earnings/transfer')
  @Roles(Role.COMPANY)
  async transfer(@CurrentUser() user: AuthUser, @Body() dto: TransferDto) {
    return this.service.transferToCredit(user.companyId, dto.amount, await this.nameOf(user));
  }

  // ----- Livreur indépendant -----
  @Get('me')
  @Roles(Role.DRIVER)
  me(@CurrentUser() user: AuthUser) {
    return this.service.forDriver(user.sub);
  }

  @Post('invites/:id/accept')
  @Roles(Role.DRIVER)
  accept(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.accept(user.sub, id);
  }

  @Post('invites/:id/decline')
  @Roles(Role.DRIVER)
  decline(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.decline(user.sub, id);
  }

  @Post('me/leave')
  @Roles(Role.DRIVER)
  leave(@CurrentUser() user: AuthUser, @Body() dto: ReasonDto) {
    return this.service.leave(user.sub, dto.reason);
  }

  // ----- Super Admin : proposer un LI à une entreprise -----
  @Post('propose')
  @Roles(Role.SUPER_ADMIN)
  async propose(@Body() dto: ProposeDto, @CurrentUser() user: AuthUser) {
    return this.service.propose(dto.profileId, dto.companyId, await this.nameOf(user));
  }

  // ----- Super Admin : retraits -----
  @Get('withdrawals')
  @Roles(Role.SUPER_ADMIN)
  withdrawals(@Query('status') status?: WithdrawalStatus) {
    return this.service.listWithdrawals(status && Object.values(WithdrawalStatus).includes(status) ? status : undefined);
  }

  @Post('withdrawals/:id/pay')
  @Roles(Role.SUPER_ADMIN)
  async pay(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PayDto) {
    return this.service.payWithdrawal(id, dto, await this.nameOf(user));
  }

  @Post('withdrawals/:id/reject')
  @Roles(Role.SUPER_ADMIN)
  async reject(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: NoteDto) {
    return this.service.rejectWithdrawal(id, dto.note, await this.nameOf(user));
  }
}
