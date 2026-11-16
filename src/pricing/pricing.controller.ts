import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsBoolean, IsLatitude, IsLongitude, IsOptional } from 'class-validator';
import { MoreThan, Repository } from 'typeorm';
import { haversineKm } from '../geo/communes';
import { GeoService } from '../geo/geo.service';
import { Role, User } from '../users/user.entity';
import { COD_FEE, computePrice, DeliverySpeed, SPEEDS, VEHICLES, VehicleType } from './pricing';

class QuoteDto {
  @IsLatitude() pickupLat: number;
  @IsLongitude() pickupLng: number;
  @IsLatitude() dropoffLat: number;
  @IsLongitude() dropoffLng: number;
  @IsOptional() @IsBoolean() cod?: boolean;
}

/** Livreur « en ligne » = position reçue il y a moins de 2 minutes */
export const ONLINE_WINDOW_MS = 2 * 60 * 1000;

@Controller('pricing')
export class PricingController {
  constructor(private geo: GeoService, @InjectRepository(User) private users: Repository<User>) {}

  /** Grille tarifaire (affichage) */
  @Get('grid')
  grid() {
    return { vehicles: VEHICLES, speeds: SPEEDS, codFee: COD_FEE };
  }

  /** Prix de chaque offre et délai pour un trajet */
  @Post('quote')
  async quote(@Body() dto: QuoteDto) {
    const route = await this.geo.route(
      { lat: dto.pickupLat, lng: dto.pickupLng },
      { lat: dto.dropoffLat, lng: dto.dropoffLng },
    );
    const offers = (Object.keys(VEHICLES) as VehicleType[]).map((vehicle) => ({
      vehicle,
      label: VEHICLES[vehicle].label,
      description: VEHICLES[vehicle].description,
      prices: Object.fromEntries(
        (Object.keys(SPEEDS) as DeliverySpeed[]).map((s) => [s, computePrice(route.distanceKm, vehicle, s, !!dto.cod)]),
      ),
    }));
    return {
      distanceKm: Math.round(route.distanceKm * 10) / 10,
      durationMin: route.durationMin,
      points: route.points,
      offers,
      speeds: SPEEDS,
      codFee: COD_FEE,
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
