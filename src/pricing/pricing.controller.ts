import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsLatitude,
  IsLongitude,
  IsOptional,
  ValidateNested,
} from 'class-validator';
import { absenceWaitMs } from '../deliveries/absence';
import { MoreThan, Repository } from 'typeorm';
import { haversineKm } from '../geo/communes';
import { GeoService } from '../geo/geo.service';
import { Role, User } from '../users/user.entity';
import {
  COD_FEE,
  computePrice,
  DeliverySpeed,
  EXTRA_STOP_FEE,
  MAX_STOPS,
  SPEEDS,
  VEHICLES,
  VehicleType,
} from './pricing';

class QuoteStopDto {
  @IsLatitude() lat: number;
  @IsLongitude() lng: number;
  /** Paiement à la livraison sur cet arrêt */
  @IsOptional() @IsBoolean() cod?: boolean;
}

class QuoteDto {
  @IsLatitude() pickupLat: number;
  @IsLongitude() pickupLng: number;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_STOPS)
  @ValidateNested({ each: true })
  @Type(() => QuoteStopDto)
  stops: QuoteStopDto[];
}

/** Livreur « en ligne » = position reçue il y a moins de 2 minutes */
export const ONLINE_WINDOW_MS = 2 * 60 * 1000;

@Controller('pricing')
export class PricingController {
  constructor(private geo: GeoService, @InjectRepository(User) private users: Repository<User>) {}

  /** Grille tarifaire (affichage) */
  @Get('grid')
  grid() {
    return {
      vehicles: VEHICLES,
      speeds: SPEEDS,
      codFee: COD_FEE,
      extraStopFee: EXTRA_STOP_FEE,
      maxStops: MAX_STOPS,
      absenceWaitMin: absenceWaitMs() / 60000,
    };
  }

  /**
   * Devis d'une course ou d'une tournée : ordre de passage optimisé, itinéraire,
   * prix de chaque offre (Moto / Voiture / Cargo) pour chaque délai.
   */
  @Post('quote')
  async quote(@Body() dto: QuoteDto) {
    const pickup = { lat: dto.pickupLat, lng: dto.pickupLng };
    const order = await this.geo.optimizeOrder(pickup, dto.stops);
    const ordered = order.map((i) => dto.stops[i]);
    const route = await this.geo.routeVia([pickup, ...ordered]);
    const codStops = ordered.filter((s) => s.cod).length;
    const offers = (Object.keys(VEHICLES) as VehicleType[]).map((vehicle) => ({
      vehicle,
      label: VEHICLES[vehicle].label,
      description: VEHICLES[vehicle].description,
      prices: Object.fromEntries(
        (Object.keys(SPEEDS) as DeliverySpeed[]).map((s) => [
          s,
          computePrice(route.distanceKm, vehicle, s, ordered.length, codStops),
        ]),
      ),
    }));
    return {
      order, // index des arrêts dans l'ordre de passage
      distanceKm: Math.round(route.distanceKm * 10) / 10,
      durationMin: route.durationMin,
      points: route.points,
      legs: route.legs,
      offers,
      speeds: SPEEDS,
      codFee: COD_FEE,
      extraStopFee: EXTRA_STOP_FEE,
    };
  }

  /** « Prise en charge ~X min » : temps d'arrivée du livreur en ligne le plus proche */
  @Get('eta')
  async eta(@Query('lat') latStr: string, @Query('lng') lngStr: string) {
    const lat = Number(latStr);
    const lng = Number(lngStr);
    const drivers = await this.users.find({
      where: { role: Role.DRIVER, active: true, lastLocationAt: MoreThan(new Date(Date.now() - ONLINE_WINDOW_MS)) },
      relations: { company: true },
    });
    const online = drivers.filter((d) => d.company?.active !== false && d.lastLat != null);
    if (!online.length || !Number.isFinite(lat) || !Number.isFinite(lng)) return { minutes: null, nearbyDrivers: 0 };
    const km = Math.min(...online.map((d) => haversineKm(lat, lng, d.lastLat, d.lastLng))) * 1.35;
    return {
      minutes: Math.max(2, Math.ceil((km / 20) * 60) + 2),
      nearbyDrivers: online.filter((d) => haversineKm(lat, lng, d.lastLat, d.lastLng) < 5).length,
    };
  }
}
