import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, Roles } from '../common/decorators';
import { Role } from '../users/user.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/user.entity';
import { AdminCancelDto, AnswerCancelDto, AssignDto, CancelRequestDto, CancelStopDto, CompanyOrderDto, ConfirmStopDto, CreateDeliveryDto, DeclineAssignmentDto, DisputeStopDto, FailStopDto, FollowUpDto, HelpAnswerDto, HelpRequestDto, RateDto, ReorderStopsDto, ResolveDisputeDto, ReturnDto } from './deliveries.dto';
import { DeliveriesService } from './deliveries.service';
import { AlertResponseDto, PlanDto } from './deliveries.dto';
import { DispatchService } from './dispatch.service';
import { PlanService } from './plan.service';

@Controller('deliveries')
export class DeliveriesController {
  constructor(
    private service: DeliveriesService,
    private plan: PlanService,
    private dispatch: DispatchService,
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

  /** Avis des clients sur un livreur (entreprise : ses livreurs et LI rattachés ; SA : tous) */
  @Get('driver-ratings/:driverId')
  @Roles(Role.COMPANY, Role.SUPER_ADMIN)
  driverRatings(@CurrentUser() user: AuthUser, @Param('driverId', ParseUUIDPipe) driverId: string) {
    return this.service.driverRatings(user, driverId);
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

  /** Note du livreur après la livraison (une seule fois) */
  @Post(':id/rate')
  @Roles(Role.CLIENT)
  rate(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RateDto) {
    return this.service.rate(user.sub, id, dto);
  }

  @Post(':id/cancel')
  @Roles(Role.CLIENT)
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelStopDto) {
    return this.service.cancel(user.sub, id, 'Client', dto?.reason?.trim() || null);
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

  /** Destinataire injoignable : réponse de l'expéditeur au livreur sur place */
  @Post(':id/stops/:stopId/help/answer')
  @Roles(Role.CLIENT)
  answerHelp(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stopId', ParseUUIDPipe) stopId: string,
    @Body() dto: HelpAnswerDto,
  ) {
    return this.service.answerHelp(user.sub, id, stopId, dto);
  }

  /** Après un échec : nouvelle tentative ou retour du colis */
  @Post(':id/stops/:stopId/follow-up')
  @Roles(Role.CLIENT)
  followUp(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stopId', ParseUUIDPipe) stopId: string,
    @Body() dto: FollowUpDto,
  ) {
    return this.service.chooseFollowUp(user.sub, id, stopId, dto);
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

  /** Tournée du livreur : ordre de passage de toutes ses courses en cours */
  @Get('driver/plan')
  @Roles(Role.DRIVER)
  getPlan(@CurrentUser() user: AuthUser) {
    return this.plan.get(user.sub);
  }

  @Put('driver/plan')
  @Roles(Role.DRIVER)
  savePlan(@CurrentUser() user: AuthUser, @Body() dto: PlanDto) {
    return this.plan.save(user.sub, dto.keys);
  }

  @Post('driver/plan/optimize')
  @Roles(Role.DRIVER)
  optimizePlan(@CurrentUser() user: AuthUser) {
    return this.plan.optimize(user.sub);
  }

  /** Réponse à l'alerte « nouvelle course » : refusée ou expirée (statistiques de réactivité) */
  @Post(':id/alert')
  @Roles(Role.DRIVER)
  alert(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AlertResponseDto) {
    return this.dispatch.respond(user.sub, id, dto.action);
  }

  /** Réactivité des livreurs (SA : tous ; gérant : ses livreurs) */
  @Get('driver-stats')
  @Roles(Role.SUPER_ADMIN, Role.COMPANY)
  driverStats(@CurrentUser() user: AuthUser, @Query('days') days?: string) {
    const n = Math.min(365, Math.max(1, Number(days) || 30));
    return this.dispatch.stats(user.role === Role.SUPER_ADMIN ? null : user.companyId, n);
  }

  @Post(':id/accept')
  @Roles(Role.DRIVER)
  accept(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.accept(user, id);
  }

  @Post(':id/pickup')
  @Roles(Role.DRIVER)
  pickup(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Headers('x-app-version') appVersion?: string) {
    // Appel obligatoire seulement pour les apps qui l'enregistrent (1.1.4 et plus) : les anciennes ne sont pas bloquées
    return this.service.pickup(user.sub, id, !!appVersion);
  }

  /** Appel passé depuis l'app : à l'expéditeur (sans arrêt) ou à un destinataire */
  @Post(':id/call')
  @Roles(Role.DRIVER)
  callSender(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.logCall(user.sub, id, null);
  }

  @Post(':id/stops/:stopId/call')
  @Roles(Role.DRIVER)
  callRecipient(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('stopId', ParseUUIDPipe) stopId: string) {
    return this.service.logCall(user.sub, id, stopId);
  }

  /** Sur place, destinataire injoignable : demander à l'expéditeur quoi faire */
  @Post(':id/stops/:stopId/help')
  @Roles(Role.DRIVER)
  requestHelp(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stopId', ParseUUIDPipe) stopId: string,
    @Body() dto: HelpRequestDto,
  ) {
    return this.service.requestHelp(user.sub, id, stopId, dto.note);
  }

  @Post(':id/stops/:stopId/deliver')
  @Roles(Role.DRIVER)
  deliverStop(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stopId', ParseUUIDPipe) stopId: string,
    @Body() dto: ConfirmStopDto,
  ) {
    return this.service.deliverStop(user.sub, id, stopId, dto.code ?? '');
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
