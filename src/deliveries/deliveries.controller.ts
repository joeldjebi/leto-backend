import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { AuthUser, CurrentUser, Roles } from '../common/decorators';
import { Role } from '../users/user.entity';
import { ConfirmDeliveryDto, CreateDeliveryDto } from './deliveries.dto';
import { DeliveriesService } from './deliveries.service';

@Controller('deliveries')
export class DeliveriesController {
  constructor(private service: DeliveriesService) {}

  // ----- Client -----
  @Post()
  @Roles(Role.CLIENT)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateDeliveryDto) {
    return this.service.create(user.sub, dto);
  }

  @Get('mine')
  @Roles(Role.CLIENT)
  mine(@CurrentUser() user: AuthUser) {
    return this.service.forClient(user.sub);
  }

  @Get('mine/:id')
  @Roles(Role.CLIENT)
  oneForClient(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.oneForClient(user.sub, id);
  }

  @Post(':id/cancel')
  @Roles(Role.CLIENT)
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.cancel(user.sub, id);
  }

  // ----- Livreur -----
  @Get('available')
  @Roles(Role.DRIVER)
  available() {
    return this.service.available();
  }

  @Get('driver')
  @Roles(Role.DRIVER)
  forDriver(@CurrentUser() user: AuthUser) {
    return this.service.forDriver(user.sub);
  }

  @Post(':id/accept')
  @Roles(Role.DRIVER)
  accept(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.accept(user, id);
  }

  @Post(':id/pickup')
  @Roles(Role.DRIVER)
  pickup(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.pickup(user.sub, id);
  }

  @Post(':id/deliver')
  @Roles(Role.DRIVER)
  deliver(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmDeliveryDto,
  ) {
    return this.service.deliver(user.sub, id, dto.code);
  }

  // ----- Entreprise / Admin -----
  @Get('company')
  @Roles(Role.COMPANY)
  forCompany(@CurrentUser() user: AuthUser) {
    return this.service.forCompany(user.companyId);
  }

  @Post(':id/cod-remitted')
  @Roles(Role.COMPANY)
  codRemitted(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.markCodRemitted(user.companyId, id);
  }

  @Get()
  @Roles(Role.SUPER_ADMIN)
  all() {
    return this.service.all();
  }
}
