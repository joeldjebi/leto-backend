import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { AuthUser, CurrentUser, Roles } from '../common/decorators';
import { Role } from '../users/user.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/user.entity';
import { AdminCancelDto, AnswerCancelDto, AssignDto, CancelRequestDto, CancelStopDto, CompanyOrderDto, ConfirmStopDto, CreateDeliveryDto, DeclineAssignmentDto, DisputeStopDto, FailStopDto, ReorderStopsDto, ResolveDisputeDto, ReturnDto } from './deliveries.dto';
import { DeliveriesService } from './deliveries.service';

@Controller('deliveries')
export class DeliveriesController {
  constructor(
    private service: DeliveriesService,
    @InjectRepository(User) private users: Repository<User>,
  ) {}

  private async nameOf(user: AuthUser) {
    return (await this.users.findOneBy({ id: user.sub }))?.name ?? user.role;
  }

  // ----- Client (particulier ou boutique) -----
  @Post()
  @Roles(Role.CLIENT)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateDeliveryDto) {
    return this.service.create(user.sub, dto, { companyId: dto.companyId });
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

  @Get('mine/:id/cancel-preview')
  @Roles(Role.CLIENT)
  cancelPreview(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.cancelPreview(user.sub, id);
  }

  @Post(':id/cancel')
  @Roles(Role.CLIENT)
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.cancel(user.sub, id);
  }

  @Post(':id/stops/:stopId/cancel')
  @Roles(Role.CLIENT)
  cancelStop(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stopId', ParseUUIDPipe) stopId: string,
    @Body() dto: CancelStopDto,
  ) {
    return this.service.cancelStop(user.sub, id, stopId, dto.reason);
  }

  @Post(':id/stops/:stopId/cancel-request/answer')
  @Roles(Role.CLIENT)
  answerCancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stopId', ParseUUIDPipe) stopId: string,
    @Body() dto: AnswerCancelDto,
  ) {
    return this.service.answerCancelRequest(user.sub, id, stopId, dto.accept);
  }

  @Post(':id/stops/:stopId/dispute')
  @Roles(Role.CLIENT)
  dispute(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stopId', ParseUUIDPipe) stopId: string,
    @Body() dto: DisputeStopDto,
  ) {
    return this.service.disputeStop(user.sub, id, stopId, dto.note);
  }

  // ----- Livreur -----
  @Get('available')
  @Roles(Role.DRIVER)
  available(@CurrentUser() user: AuthUser) {
    return this.service.available(user);
  }

  @Post(':id/decline-assignment')
  @Roles(Role.DRIVER)
  declineAssignment(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DeclineAssignmentDto) {
    return this.service.declineAssignment(user.sub, id, dto.reason);
  }

  @Post(':id/open-to-all')
  @Roles(Role.CLIENT)
  openToAll(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.openToAll(user.sub, id);
  }

  @Post('company-order')
  @Roles(Role.COMPANY)
  companyOrder(@CurrentUser() user: AuthUser, @Body() dto: CompanyOrderDto) {
    return this.service.createForCompany(user.companyId, dto);
  }

  @Post(':id/assign')
  @Roles(Role.COMPANY)
  assign(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignDto) {
    return this.service.assign(user.companyId, id, dto.driverId ?? null);
  }

  @Post(':id/stops/order')
  @Roles(Role.COMPANY)
  reorder(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReorderStopsDto) {
    return this.service.reorderStops(user.companyId, id, dto.stopIds);
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

  @Post(':id/stops/:stopId/deliver')
  @Roles(Role.DRIVER)
  deliverStop(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stopId', ParseUUIDPipe) stopId: string,
    @Body() dto: ConfirmStopDto,
  ) {
    return this.service.deliverStop(user.sub, id, stopId, dto.code);
  }

  @Post(':id/stops/:stopId/fail')
  @Roles(Role.DRIVER)
  failStop(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stopId', ParseUUIDPipe) stopId: string,
    @Body() dto: FailStopDto,
  ) {
    return this.service.failStop(user.sub, id, stopId, dto);
  }

  // ----- Entreprise / Super Admin -----
  @Post(':id/stops/:stopId/cancel-request')
  @Roles(Role.DRIVER)
  requestCancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stopId', ParseUUIDPipe) stopId: string,
    @Body() dto: CancelRequestDto,
  ) {
    return this.service.requestStopCancel(user.sub, id, stopId, dto.note);
  }

  @Post(':id/return')
  @Roles(Role.DRIVER)
  confirmReturn(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReturnDto) {
    return this.service.confirmReturn(user.sub, id, dto.code);
  }

  @Post(':id/cancellation-fee/settled')
  @Roles(Role.COMPANY)
  settleFee(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.settleCancellationFee(user.companyId, id);
  }

  @Get('company')
  @Roles(Role.COMPANY)
  forCompany(@CurrentUser() user: AuthUser) {
    return this.service.forCompany(user.companyId);
  }

  @Post(':id/stops/:stopId/cod-remitted')
  @Roles(Role.COMPANY)
  codRemitted(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stopId', ParseUUIDPipe) stopId: string,
  ) {
    return this.service.markCodRemitted(user.companyId, id, stopId);
  }

  @Post(':id/stops/:stopId/resolve')
  @Roles(Role.SUPER_ADMIN, Role.COMPANY)
  async resolve(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stopId', ParseUUIDPipe) stopId: string,
    @Body() dto: ResolveDisputeDto,
  ) {
    return this.service.resolveDispute(user, await this.nameOf(user), id, stopId, dto.decision, dto.note);
  }

  @Post(':id/admin-cancel')
  @Roles(Role.SUPER_ADMIN)
  async adminCancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminCancelDto) {
    return this.service.adminCancel(id, dto.reason, await this.nameOf(user));
  }

  @Get()
  @Roles(Role.SUPER_ADMIN)
  all() {
    return this.service.all();
  }
}
