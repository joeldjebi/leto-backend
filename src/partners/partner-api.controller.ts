import { Body, CanActivate, Controller, createParamDecorator, ExecutionContext, Get, Headers, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsEnum, IsInt, IsLatitude, IsLongitude, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Repository } from 'typeorm';
import { Public } from '../common/decorators';
import { IsPhone, PHONE_MESSAGE } from '../countries/phone';
import { Delivery } from '../deliveries/delivery.entity';
import { DeliveriesService } from '../deliveries/deliveries.service';
import { allInGrandAbidjan } from '../geo/communes';
import { GeoService } from '../geo/geo.service';
import { computePrice, DeliverySpeed, MAX_STOPS, VehicleType } from '../pricing/pricing';
import { SurchargeService } from '../pricing/surcharge.service';
import { SettingsService } from '../settings/settings.service';
import { Partner } from './partner.entities';
import { PartnersService } from './partners.service';

/** Clé d'API vérifiée (interrupteurs du SA compris) ; le partenaire est attaché à la requête */
@Injectable()
export class PartnerGuard implements CanActivate {
  constructor(private partners: PartnersService) {}
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const [type, token] = (req.headers.authorization ?? '').split(' ');
    req.partner = await this.partners.authenticate(type === 'Bearer' ? token : (req.headers['x-api-key'] as string | undefined));
    return true;
  }
}
const CurrentPartner = createParamDecorator((_: unknown, ctx: ExecutionContext): Partner => ctx.switchToHttp().getRequest().partner);

class PointDto {
  @IsLatitude() lat: number;
  @IsLongitude() lng: number;
}
class QuoteStopDto extends PointDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) codAmount?: number;
}
class QuoteDto {
  @ValidateNested() @Type(() => PointDto) pickup: PointDto;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_STOPS) @ValidateNested({ each: true }) @Type(() => QuoteStopDto) stops: QuoteStopDto[];
  @IsOptional() @IsUUID() companyId?: string;
}
class PickupDto extends PointDto {
  @IsString() @IsNotEmpty() @MaxLength(200) address: string;
  @IsPhone({ message: `Téléphone du départ : ${PHONE_MESSAGE}` }) phone: string;
  @IsOptional() @IsString() @MaxLength(100) contactName?: string;
  @IsOptional() @IsString() @MaxLength(500) details?: string;
}
class StopDto extends PointDto {
  @IsString() @IsNotEmpty() @MaxLength(200) address: string;
  @IsString() @IsNotEmpty() @MaxLength(100) recipientName: string;
  @IsPhone({ message: `Téléphone du destinataire : ${PHONE_MESSAGE}` }) recipientPhone: string;
  @IsOptional() @IsString() @MaxLength(500) details?: string;
  @IsOptional() @IsString() @MaxLength(300) packageDescription?: string;
  /** Montant à encaisser auprès du destinataire (FCFA) */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(5_000_000) codAmount?: number;
}
class CreateDto {
  /** Référence de la commande chez le partenaire (renvoyée dans les webhooks) */
  @IsOptional() @IsString() @MaxLength(100) reference?: string;
  @IsOptional() @IsEnum(VehicleType) vehicleType?: VehicleType;
  @IsOptional() @IsEnum(DeliverySpeed) speed?: DeliverySpeed;
  /** Entreprise de livraison choisie (facultatif) */
  @IsOptional() @IsUUID() companyId?: string;
  @ValidateNested() @Type(() => PickupDto) pickup: PickupDto;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_STOPS) @ValidateNested({ each: true }) @Type(() => StopDto) stops: StopDto[];
  @IsOptional() @IsString() @MaxLength(500) comment?: string;
}
class CancelDto {
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}
class StatementQuery {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) to?: string;
}

/**
 * API partenaire v1 (Adjamé-Smart, boutiques en ligne…) : authentification par clé d'API
 * (Authorization: Bearer leto_live_…), désactivable par le SA (général ou par partenaire).
 */
@Public()
@UseGuards(PartnerGuard)
@Controller('partner/v1')
export class PartnerApiController {
  constructor(
    private partners: PartnersService,
    private deliveries: DeliveriesService,
    private geo: GeoService,
    private settings: SettingsService,
    private surcharge: SurchargeService,
    @InjectRepository(Delivery) private repo: Repository<Delivery>,
  ) {}

  @Get('me')
  me(@CurrentPartner() p: Partner) {
    return { id: p.id, name: p.name, active: p.active, webhookUrl: p.webhookUrl };
  }

  /** Devis : prix de chaque engin et délai, distance et durée */
  @Post('quotes')
  @HttpCode(200)
  async quote(@Body() dto: QuoteDto) {
    const grid = this.settings.pricing;
    const pickup = { lat: dto.pickup.lat, lng: dto.pickup.lng };
    const order = await this.geo.optimizeOrder(pickup, dto.stops);
    const ordered = order.map((i) => dto.stops[i]);
    const route = await this.geo.routeVia([pickup, ...ordered]);
    const codStops = grid.codEnabled ? ordered.filter((s) => (s.codAmount ?? 0) > 0).length : 0;
    const inAbidjan = allInGrandAbidjan([pickup, ...ordered]);
    const sur = this.surcharge.context([pickup, ...ordered]);
    return {
      currency: 'XOF',
      distanceKm: Math.round(route.distanceKm * 10) / 10,
      durationMin: route.durationMin,
      codEnabled: grid.codEnabled,
      surchargePct: sur.pct,
      prices: (Object.keys(grid.vehicles) as VehicleType[])
        .filter((v) => grid.vehicles[v].enabled)
        .flatMap((vehicleType) =>
          (Object.keys(grid.speeds) as DeliverySpeed[]).map((speed) => ({
            vehicleType,
            speed,
            price: computePrice(grid, route.distanceKm, vehicleType, speed, ordered.length, codStops, { inAbidjan, surchargePct: sur.pct }),
          })),
        ),
    };
  }

  /** Nouvelle course ; en-tête Idempotency-Key : la même clé renvoie la même course */
  @Post('deliveries')
  async create(@CurrentPartner() p: Partner, @Body() dto: CreateDto, @Headers('idempotency-key') idem?: string) {
    const key = idem?.trim().slice(0, 100) || null;
    if (key) {
      const existing = await this.repo.findOneBy({ partnerId: p.id, partnerIdemKey: key });
      if (existing) return this.partners.view(await this.deliveries.oneForClient(p.userId, existing.id));
    }
    const d = await this.deliveries.create(
      p.userId,
      {
        vehicleType: dto.vehicleType,
        speed: dto.speed,
        pickupLat: dto.pickup.lat,
        pickupLng: dto.pickup.lng,
        pickupAddress: dto.pickup.address,
        pickupPhone: dto.pickup.phone,
        pickupContactName: dto.pickup.contactName,
        pickupDetails: dto.pickup.details,
        stops: dto.stops.map((s) => ({ lat: s.lat, lng: s.lng, address: s.address, recipientName: s.recipientName, recipientPhone: s.recipientPhone, details: s.details, packageDescription: s.packageDescription, codAmount: s.codAmount })),
        courierComment: dto.comment,
      },
      { companyId: dto.companyId ?? null, partner: { id: p.id, reference: dto.reference?.trim() || null, idemKey: key } },
    );
    return this.partners.view(d);
  }

  @Get('deliveries')
  async list(@CurrentPartner() p: Partner, @Query('reference') reference?: string) {
    const rows = await this.repo.find({ where: { partnerId: p.id, ...(reference ? { partnerReference: reference } : {}) }, order: { createdAt: 'DESC' }, take: 50 });
    const out = [];
    for (const r of rows) out.push(this.partners.view(await this.deliveries.oneForClient(p.userId, r.id)));
    return out;
  }

  @Get('deliveries/:id')
  async one(@CurrentPartner() p: Partner, @Param('id', ParseUUIDPipe) id: string) {
    const d = await this.repo.findOneBy({ id, partnerId: p.id });
    if (!d) throw new NotFoundException('Course introuvable');
    return this.partners.view(await this.deliveries.oneForClient(p.userId, id));
  }

  @Post('deliveries/:id/cancel')
  @HttpCode(200)
  async cancel(@CurrentPartner() p: Partner, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelDto) {
    const d = await this.repo.findOneBy({ id, partnerId: p.id });
    if (!d) throw new NotFoundException('Course introuvable');
    await this.deliveries.cancel(p.userId, id, p.name, dto.reason?.trim() || null);
    return this.partners.view(await this.deliveries.oneForClient(p.userId, id));
  }

  /** Relevé des encaissements à la livraison (reversés ou non) */
  @Get('statement')
  statement(@CurrentPartner() p: Partner, @Query() q: StatementQuery) {
    return this.partners.statement(p.id, q.from, q.to);
  }
}
