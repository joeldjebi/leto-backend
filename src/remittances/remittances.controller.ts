import { Body, Controller, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { Repository } from 'typeorm';
import { AuthUser, CurrentUser, Roles } from '../common/decorators';
import { Role, User } from '../users/user.entity';
import { RemittancesService } from './remittances.service';

class RemittanceDto {
  @Type(() => Number)
  @IsInt({ message: 'Montant entier attendu' })
  @Min(100, { message: 'Montant minimum : 100 F' })
  amount: number;

  @IsIn(['CASH', 'MOBILE_MONEY'], { message: 'Mode : espèces ou Mobile Money' })
  method: 'CASH' | 'MOBILE_MONEY';

  @IsOptional() @IsString() @MaxLength(80) reference?: string;
  @IsOptional() @Matches(/^\/uploads\/[0-9a-f-]{36}\.(jpg|png|webp|heic)$/, { message: 'Preuve invalide' }) proofUrl?: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

class ConfirmDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) amount?: number;
}

class RejectDto {
  @IsString() @IsNotEmpty({ message: 'Motif obligatoire' }) @MaxLength(300) note: string;
}

class ShareDto {
  @Type(() => Number) @IsNumber() @Min(0) @Max(100) percent: number;
}

/** Gains des livreurs et versements à leur entreprise */
@Controller('remittances')
export class RemittancesController {
  constructor(
    private service: RemittancesService,
    @InjectRepository(User) private users: Repository<User>,
  ) {}

  private async name(user: AuthUser) {
    return (await this.users.findOneBy({ id: user.sub }))?.name ?? 'Entreprise';
  }

  // ----- Livreur -----
  @Get('me')
  @Roles(Role.DRIVER)
  mine(@CurrentUser() user: AuthUser) {
    return this.service.mine(user.sub, user.companyId);
  }

  @Post('me')
  @Roles(Role.DRIVER)
  declare(@CurrentUser() user: AuthUser, @Body() dto: RemittanceDto) {
    return this.service.declare(user.sub, user.companyId, dto);
  }

  // ----- Entreprise -----
  @Get('company')
  @Roles(Role.COMPANY)
  company(@CurrentUser() user: AuthUser) {
    return this.service.forCompany(user.companyId);
  }

  @Put('company/share')
  @Roles(Role.COMPANY)
  share(@CurrentUser() user: AuthUser, @Body() dto: ShareDto) {
    return this.service.setSharePercent(user.companyId, dto.percent);
  }

  @Post('drivers/:id')
  @Roles(Role.COMPANY)
  async record(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RemittanceDto) {
    return this.service.record(user.companyId, await this.name(user), id, dto);
  }

  @Post(':id/confirm')
  @Roles(Role.COMPANY)
  async confirm(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ConfirmDto) {
    return this.service.confirm(user.companyId, await this.name(user), id, dto.amount);
  }

  @Post(':id/reject')
  @Roles(Role.COMPANY)
  async reject(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectDto) {
    return this.service.reject(user.companyId, await this.name(user), id, dto.note);
  }

  // ----- Entreprise (ses livreurs) et SA (lecture) -----
  @Get('drivers/:id')
  @Roles(Role.COMPANY, Role.SUPER_ADMIN)
  async driver(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const driver = await this.users.findOneBy({ id, role: Role.DRIVER });
    if (!driver?.companyId) throw new NotFoundException('Livreur introuvable');
    // LI rattaché : ses encaissements sont versés à son entreprise de rattachement
    const payee = (await this.service.payeeOf(driver.companyId)).companyId;
    if (!payee) throw new NotFoundException('Ce livreur indépendant n’est rattaché à aucune entreprise');
    if (user.role === Role.COMPANY && payee !== user.companyId) throw new ForbiddenException();
    return this.service.forDriver(payee, id);
  }
}
