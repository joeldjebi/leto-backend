import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { IsDateString, IsEnum, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, MaxLength, Min, ValidateIf } from 'class-validator';
import { Repository } from 'typeorm';
import { AuthUser, CurrentUser, Roles } from '../common/decorators';
import { PHONE_MESSAGE, PHONE_REGEX } from '../common/dto';
import { Role, User } from '../users/user.entity';
import { PaymentKind, PaymentStatus } from './billing.entities';
import { BillingConfig, BillingService, CommissionType } from './billing.service';

class SubmitPaymentDto {
  @IsEnum(PaymentKind, { message: 'Type de paiement : abonnement ou recharge' })
  kind: PaymentKind;

  @Type(() => Number)
  @IsInt({ message: 'Montant entier attendu' })
  @Min(500, { message: 'Montant minimum : 500 F' })
  amount: number;

  @IsString()
  @IsNotEmpty({ message: 'Opérateur obligatoire' })
  operator: string;

  @Matches(PHONE_REGEX, { message: PHONE_MESSAGE })
  senderPhone: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  reference?: string;

  @Matches(/^\/uploads\/[0-9a-f-]{36}\.(jpg|png|webp|heic)$/, { message: 'Preuve de paiement (capture) obligatoire' })
  proofUrl: string;
}

class ApproveDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  amount?: number;
}

class RejectDto {
  @IsString()
  @IsNotEmpty({ message: 'Motif obligatoire' })
  @MaxLength(300)
  note: string;
}

class AdjustDto {
  @Type(() => Number)
  @IsInt({ message: 'Montant entier attendu' })
  amount: number;

  @IsString()
  @IsNotEmpty({ message: 'Motif obligatoire' })
  @MaxLength(300)
  note: string;
}

class SubscriptionDto {
  @ValidateIf((o) => o.endsAt !== null)
  @IsDateString({}, { message: 'Date invalide' })
  endsAt: string | null;
}

class CommissionDto {
  @ValidateIf((o) => o.type !== null)
  @IsIn(['PERCENT', 'FIXED'])
  type: CommissionType | null;

  @ValidateIf((o) => o.type !== null)
  @Type(() => Number)
  @IsNumber()
  value: number | null;
}

/** Abonnement annuel, crédit et commissions des entreprises de livraison */
@Controller('billing')
export class BillingController {
  constructor(
    private billing: BillingService,
    @InjectRepository(User) private users: Repository<User>,
  ) {}

  private async name(user: AuthUser) {
    return (await this.users.findOneBy({ id: user.sub }))?.name ?? 'LETO';
  }

  // ----- Gérant -----
  @Get('me')
  @Roles(Role.COMPANY)
  mine(@CurrentUser() user: AuthUser) {
    return this.billing.overview(user.companyId);
  }

  @Post('me/payments')
  @Roles(Role.COMPANY)
  async submit(@CurrentUser() user: AuthUser, @Body() dto: SubmitPaymentDto) {
    return this.billing.submit(user.companyId, await this.name(user), dto);
  }

  // ----- Livreur -----
  @Get('driver-status')
  @Roles(Role.DRIVER)
  driverStatus(@CurrentUser() user: AuthUser) {
    return this.billing.driverStatus(user.companyId);
  }

  // ----- Super Admin -----
  @Get('config')
  @Roles(Role.SUPER_ADMIN)
  config() {
    return this.billing.config;
  }

  @Put('config')
  @Roles(Role.SUPER_ADMIN)
  async updateConfig(@CurrentUser() user: AuthUser, @Body() body: Partial<BillingConfig>) {
    return this.billing.updateConfig(body, await this.name(user));
  }

  @Get('summary')
  @Roles(Role.SUPER_ADMIN)
  summary() {
    return this.billing.summary();
  }

  @Get('payments')
  @Roles(Role.SUPER_ADMIN)
  payments(@Query('status') status?: PaymentStatus) {
    return this.billing.list(Object.values(PaymentStatus).includes(status) ? status : undefined);
  }

  @Post('payments/:id/approve')
  @Roles(Role.SUPER_ADMIN)
  async approve(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ApproveDto) {
    return this.billing.approve(id, await this.name(user), dto.amount);
  }

  @Post('payments/:id/reject')
  @Roles(Role.SUPER_ADMIN)
  async reject(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectDto) {
    return this.billing.reject(id, await this.name(user), dto.note);
  }

  @Get('companies/:id')
  @Roles(Role.SUPER_ADMIN)
  company(@Param('id', ParseUUIDPipe) id: string) {
    return this.billing.overview(id);
  }

  @Post('companies/:id/adjust')
  @Roles(Role.SUPER_ADMIN)
  async adjust(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdjustDto) {
    await this.billing.adjust(id, dto.amount, dto.note, await this.name(user));
    return this.billing.overview(id);
  }

  @Put('companies/:id/subscription')
  @Roles(Role.SUPER_ADMIN)
  subscription(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SubscriptionDto) {
    return this.billing.setSubscription(id, dto.endsAt);
  }

  @Put('companies/:id/commission')
  @Roles(Role.SUPER_ADMIN)
  commission(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CommissionDto) {
    return this.billing.setCommission(id, dto.type, dto.value);
  }
}
