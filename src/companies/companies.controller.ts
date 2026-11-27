import { NotifyService } from '../notifications/notify.service';
import { Body, Controller, Delete, Get, Param, ParseBoolPipe, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, Public, Roles } from '../common/decorators';
import { TrackingGateway } from '../tracking/tracking.gateway';
import { Role } from '../users/user.entity';
import { ApplyCompanyDto, AvailabilityDto, CreateCompanyDto, DriverDto, OrderAccessDto, DriverVehicleDto, ReviewNoteDto, UpdateCompanyDto, VehiclesDto } from './companies.dto';
import { CompaniesService } from './companies.service';

@Controller('companies')
export class CompaniesController {
  constructor(
    private service: CompaniesService,
    private tracking: TrackingGateway,
    private notify: NotifyService,
  ) {}

  // ----- Admin plateforme -----
  @Get()
  @Roles(Role.SUPER_ADMIN)
  findAll(@Query('status') status?: string) {
    return this.service.findAll(['PENDING', 'APPROVED', 'REJECTED'].includes(status ?? '') ? status : undefined);
  }

  // ----- Inscription en ligne (landing page), validée par VITE -----
  @Public()
  @Post('apply')
  async apply(@Body() dto: ApplyCompanyDto) {
    const r = await this.service.apply(dto);
    this.tracking.server?.to('super-admin').emit('companies:changed', { id: r.id });
    this.notify.office({ sa: true }, 'COMPANY_APPLY', {
      title: 'Nouvelle entreprise à valider',
      body: `${dto.name} demande à devenir partenaire`,
      link: '/entreprises',
    });
    return r;
  }

  @Post(':id/approve')
  @Roles(Role.SUPER_ADMIN)
  approve(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.review(id, true);
  }

  @Post(':id/reject')
  @Roles(Role.SUPER_ADMIN)
  reject(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReviewNoteDto) {
    return this.service.review(id, false, dto.note);
  }

  @Post()
  @Roles(Role.SUPER_ADMIN)
  create(@Body() dto: CreateCompanyDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @Roles(Role.SUPER_ADMIN)
  update(@Param('id') id: string, @Body() dto: UpdateCompanyDto) {
    return this.service.update(id, dto);
  }

  @Patch(':id/active')
  @Roles(Role.SUPER_ADMIN)
  setActive(@Param('id') id: string, @Query('value', ParseBoolPipe) value: boolean) {
    return this.service.setActive(id, value);
  }

  // ----- Gérant : grille tarifaire de l'entreprise -----
  @Get('me/pricing')
  @Roles(Role.COMPANY)
  myPricing(@CurrentUser() user: AuthUser) {
    return this.service.pricing(user.companyId);
  }

  @Put('me/pricing')
  @Roles(Role.COMPANY)
  setPricing(@CurrentUser() user: AuthUser, @Body() body: Record<string, unknown>) {
    return this.service.setPricing(user.companyId, body);
  }

  @Put('me/vehicles')
  @Roles(Role.COMPANY)
  setVehicles(@CurrentUser() user: AuthUser, @Body() body: VehiclesDto) {
    return this.service.setVehicles(user.companyId, body.vehicles);
  }

  @Delete('me/pricing')
  @Roles(Role.COMPANY)
  resetPricing(@CurrentUser() user: AuthUser) {
    return this.service.setPricing(user.companyId, null);
  }

  // ----- Gérant : ouverture aux commandes des clients -----
  @Get('me/availability')
  @Roles(Role.COMPANY)
  availability(@CurrentUser() user: AuthUser) {
    return this.service.availability(user.companyId);
  }

  @Put('me/availability')
  @Roles(Role.COMPANY)
  setAvailability(@CurrentUser() user: AuthUser, @Body() body: AvailabilityDto) {
    return this.service.setAvailability(user.companyId, body);
  }

  // ----- SA : accès de ses livreurs aux commandes ouvertes -----
  @Put(':id/order-access')
  @Roles(Role.SUPER_ADMIN)
  setOrderAccess(@Param('id', ParseUUIDPipe) id: string, @Body() body: OrderAccessDto) {
    return this.service.setOrderAccess(id, body);
  }

  // ----- Clients : annuaire des entreprises de livraison -----
  @Get('directory')
  @Roles(Role.CLIENT)
  directory() {
    return this.service.directory();
  }

  // ----- Gérant d'entreprise : ses livreurs -----
  @Get('me/drivers')
  @Roles(Role.COMPANY)
  listDrivers(@CurrentUser() user: AuthUser) {
    return this.service.listDrivers(user.companyId);
  }

  @Post('me/drivers')
  @Roles(Role.COMPANY)
  addDriver(@CurrentUser() user: AuthUser, @Body() dto: DriverDto) {
    return this.service.addDriver(user.companyId, dto);
  }

  @Patch('me/drivers/:id/vehicle')
  @Roles(Role.COMPANY)
  setDriverVehicle(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: DriverVehicleDto) {
    return this.service.setDriverVehicle(user.companyId, id, dto.vehicleType, dto.plate);
  }

  @Patch('me/drivers/:id/active')
  @Roles(Role.COMPANY)
  setDriverActive(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('value', ParseBoolPipe) value: boolean,
  ) {
    return this.service.setDriverActive(user.companyId, id, value);
  }
}
