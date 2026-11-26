import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import type { Response } from 'express';
import { Repository } from 'typeorm';
import { AuthUser, CurrentUser, Roles } from '../common/decorators';
import { Role, User } from '../users/user.entity';
import type { PayPeriod } from './payroll.entities';
import { PayrollService } from './payroll.service';

class BonusDto {
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) min?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) stops?: number;
  @Type(() => Number) @IsNumber() @Min(0) amount: number;
}
class RuleDto {
  @Type(() => Number) @IsNumber() @Min(0) fixed: number;
  @Type(() => Number) @IsNumber() @Min(0) perStop: number;
  @Type(() => Number) @IsNumber() @Min(0) @Max(100) percent: number;
  @IsOptional() @ValidateNested() @Type(() => BonusDto) ratingBonus?: { min: number; amount: number } | null;
  @IsOptional() @ValidateNested() @Type(() => BonusDto) volumeBonus?: { stops: number; amount: number } | null;
}
class SettingsDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsIn(['WEEK', 'FORTNIGHT', 'MONTH'], { message: 'Période : semaine, quinzaine ou mois' }) period?: PayPeriod;
  @IsOptional() @ValidateNested() @Type(() => RuleDto) rule?: RuleDto;
}
class DriverRuleDto {
  @IsOptional() @ValidateNested() @Type(() => RuleDto) rule?: RuleDto | null;
}
class LineDto {
  @IsIn(['BONUS', 'DEDUCTION']) kind: 'BONUS' | 'DEDUCTION';
  @IsString() @IsNotEmpty({ message: 'Libellé obligatoire' }) @MaxLength(120) label: string;
  @Type(() => Number) @IsInt({ message: 'Montant entier attendu' }) @Min(1) amount: number;
}
class PayDto {
  @IsIn(['CASH', 'MOBILE_MONEY']) method: 'CASH' | 'MOBILE_MONEY';
  @IsOptional() @IsString() @MaxLength(100) reference?: string;
  @IsOptional() @Matches(/^\/uploads\/[\w.-]+$/) proofUrl?: string;
}
class AdvanceDecisionDto {
  @IsIn(['CASH', 'MOBILE_MONEY']) method: 'CASH' | 'MOBILE_MONEY';
  @IsOptional() @IsString() @MaxLength(100) reference?: string;
}
class NoteDto {
  @IsString() @IsNotEmpty({ message: 'Motif obligatoire' }) @MaxLength(300) note: string;
}
class RecordAdvanceDto {
  @IsUUID() driverId: string;
  @Type(() => Number) @IsInt({ message: 'Montant entier attendu' }) @Min(1) amount: number;
  @IsIn(['CASH', 'MOBILE_MONEY']) method: 'CASH' | 'MOBILE_MONEY';
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
  @IsOptional() @IsString() @MaxLength(100) reference?: string;
}
class RequestAdvanceDto {
  @Type(() => Number) @IsInt({ message: 'Montant entier attendu' }) @Min(1) amount: number;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

@Controller('payroll')
export class PayrollController {
  constructor(private service: PayrollService, @InjectRepository(User) private users: Repository<User>) {}

  private async name(user: AuthUser) {
    return (await this.users.findOneBy({ id: user.sub }))?.name ?? 'Gérant';
  }

  // ----- Entreprise -----
  @Get('settings')
  @Roles(Role.COMPANY)
  settings(@CurrentUser() u: AuthUser) {
    return this.service.settings(u.companyId);
  }

  @Put('settings')
  @Roles(Role.COMPANY)
  setSettings(@CurrentUser() u: AuthUser, @Body() dto: SettingsDto) {
    return this.service.setSettings(u.companyId, dto);
  }

  @Put('drivers/:id/rule')
  @Roles(Role.COMPANY)
  driverRule(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DriverRuleDto) {
    return this.service.setDriverRule(u.companyId, id, dto.rule ?? null);
  }

  @Get('drivers/:id/payslips')
  @Roles(Role.COMPANY)
  driverSlips(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.driverSlips(u.companyId, id);
  }

  @Get('period')
  @Roles(Role.COMPANY)
  overview(@CurrentUser() u: AuthUser, @Query('start') start?: string) {
    return this.service.overview(u.companyId, start);
  }

  @Post('period/prepare')
  @Roles(Role.COMPANY)
  prepare(@CurrentUser() u: AuthUser, @Query('start') start?: string) {
    return this.service.prepare(u.companyId, start);
  }

  @Get('period/export')
  @Roles(Role.COMPANY)
  async exportCsv(@CurrentUser() u: AuthUser, @Res() res: Response, @Query('start') start?: string) {
    const csv = await this.service.exportCsv(u.companyId, start);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="paye-${start ?? 'periode'}.csv"`);
    res.send(csv);
  }

  @Get('payslips/:id')
  @Roles(Role.COMPANY)
  one(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.one(u.companyId, id);
  }

  @Post('payslips/:id/refresh')
  @Roles(Role.COMPANY)
  refresh(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.refresh(u.companyId, id);
  }

  @Post('payslips/:id/lines')
  @Roles(Role.COMPANY)
  addLine(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: LineDto) {
    return this.service.addLine(u.companyId, id, dto);
  }

  @Post('payslips/:id/lines/:lineId/remove')
  @Roles(Role.COMPANY)
  removeLine(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('lineId', ParseUUIDPipe) lineId: string) {
    return this.service.removeLine(u.companyId, id, lineId);
  }

  @Post('payslips/:id/pay')
  @Roles(Role.COMPANY)
  async pay(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PayDto) {
    return this.service.pay(u.companyId, id, dto, await this.name(u));
  }

  @Post('advances')
  @Roles(Role.COMPANY)
  async recordAdvance(@CurrentUser() u: AuthUser, @Body() dto: RecordAdvanceDto) {
    return this.service.recordAdvance(u.companyId, dto, await this.name(u));
  }

  @Post('advances/:id/approve')
  @Roles(Role.COMPANY)
  async approve(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdvanceDecisionDto) {
    return this.service.approveAdvance(u.companyId, id, dto, await this.name(u));
  }

  @Post('advances/:id/reject')
  @Roles(Role.COMPANY)
  async reject(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: NoteDto) {
    return this.service.rejectAdvance(u.companyId, id, dto.note, await this.name(u));
  }

  // ----- Livreur -----
  @Get('me')
  @Roles(Role.DRIVER)
  me(@CurrentUser() u: AuthUser) {
    return this.service.forDriver(u.sub);
  }

  @Post('me/payslips/:id/confirm')
  @Roles(Role.DRIVER)
  confirm(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.confirm(u.sub, id);
  }

  @Post('me/payslips/:id/dispute')
  @Roles(Role.DRIVER)
  dispute(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: NoteDto) {
    return this.service.dispute(u.sub, id, dto.note);
  }

  @Post('me/advances')
  @Roles(Role.DRIVER)
  requestAdvance(@CurrentUser() u: AuthUser, @Body() dto: RequestAdvanceDto) {
    return this.service.requestAdvance(u.sub, dto.amount, dto.reason);
  }
}
