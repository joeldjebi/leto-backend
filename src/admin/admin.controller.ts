import { Body, Controller, Get, Post, Put, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthUser, CurrentUser, Roles } from '../common/decorators';
import { PricingGrid } from '../pricing/pricing';
import { MapSettings, MapStyleService } from '../geo/map-style.service';
import { SettingsService } from '../settings/settings.service';
import { Role, User } from '../users/user.entity';
import { StatsService } from './stats.service';

/** Back-office : indicateurs (SA et gérants), tarifs et règles (SA) */
@Controller('admin')
export class AdminController {
  constructor(
    private stats: StatsService,
    private settings: SettingsService,
    private mapStyle: MapStyleService,
    @InjectRepository(User) private users: Repository<User>,
  ) {}

  @Get('stats')
  @Roles(Role.SUPER_ADMIN, Role.COMPANY)
  getStats(@CurrentUser() user: AuthUser, @Query('days') days?: string) {
    const n = Math.min(90, Math.max(7, Number(days) || 14));
    return this.stats.stats(user.role === Role.COMPANY ? user.companyId : null, n);
  }

  @Get('settings')
  @Roles(Role.SUPER_ADMIN)
  getSettings() {
    return this.settings.info;
  }

  @Put('settings')
  @Roles(Role.SUPER_ADMIN)
  async updateSettings(@CurrentUser() user: AuthUser, @Body() body: Partial<PricingGrid>) {
    const me = await this.users.findOneBy({ id: user.sub });
    return this.settings.updatePricing(body, me?.name ?? 'Super Admin');
  }

  @Get('map')
  @Roles(Role.SUPER_ADMIN)
  getMap() {
    return this.mapStyle.adminSettings;
  }

  @Put('map')
  @Roles(Role.SUPER_ADMIN)
  async updateMap(@CurrentUser() user: AuthUser, @Body() body: Partial<MapSettings>) {
    const me = await this.users.findOneBy({ id: user.sub });
    return this.mapStyle.update(body, me?.name ?? 'Super Admin');
  }

  @Post('settings/reset')
  @Roles(Role.SUPER_ADMIN)
  async resetSettings(@CurrentUser() user: AuthUser) {
    const me = await this.users.findOneBy({ id: user.sub });
    return this.settings.reset(me?.name ?? 'Super Admin');
  }
}
