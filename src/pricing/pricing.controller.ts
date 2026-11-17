import { BadRequestException, Body, Controller, Get, Post, Query } from '@nestjs/common';
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
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { MoreThan, Repository } from 'typeorm';
import { Company } from '../companies/company.entity';
import { allInGrandAbidjan, haversineKm } from '../geo/communes';
import { GeoService } from '../geo/geo.service';
import { Role, User } from '../users/user.entity';
import { SettingsService } from '../settings/settings.service';
import { computePrice, DeliverySpeed, MAX_STOPS, stopDiscountPct, VehicleType } from './pricing';
import { SurchargeService } from './surcharge.service';

class QuoteStopDto {
  @IsLatitude() lat: number;
  @IsLongitude() lng: number;
  /** Paiement à la livraison sur cet arrêt */
  @IsOptional() @IsBoolean() cod?: boolean;
}

class QuoteDto {
  /** Entreprise choisie (sa grille tarifaire) */
  @IsOptional() @IsUUID() companyId?: string;
  @IsLatitude() pickupLat: number;
  @IsLongitude() pickupLng: number;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_STOPS)
  @ValidateNested({ each: true })
  @Type(() => QuoteStopDto)
  stops: QuoteStopDto[];
  /** Garder l'ordre saisi (sinon ordre optimisé) */
  @IsOptional() @IsBoolean() keepOrder?: boolean;
}

/** Livreur « en ligne » = position reçue il y a moins de 2 minutes */
export const ONLINE_WINDOW_MS = 2 * 60 * 1000;

@Controller('pricing')
export class PricingController {
  constructor(
    private geo: GeoService,
    private settings: SettingsService,
    private surcharge: SurchargeService,
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(Company) private companies: Repository<Company>,
  ) {}

  /** Grille tarifaire (affichage) */
  @Get('grid')
  grid() {
    return this.settings.pricing;
  }

  /**
   * Devis d'une course ou d'une tournée : ordre de passage optimisé, itinéraire,
   * prix de chaque offre (Moto / Voiture / Cargo) pour chaque délai.
   */
  @Post('quote')
  async quote(@Body() dto: QuoteDto) {
    const company = dto.companyId ? await this.companies.findOneBy({ id: dto.companyId }) : null;
    const grid = this.settings.gridFor(company);
    if (dto.stops.length > grid.maxStops) throw new BadRequestException(`${grid.maxStops} adresses maximum par tournée`);
    const pickup = { lat: dto.pickupLat, lng: dto.pickupLng };
    const order = dto.keepOrder ? dto.stops.map((_, i) => i) : await this.geo.optimizeOrder(pickup, dto.stops);
    const ordered = order.map((i) => dto.stops[i]);
    const route = await this.geo.routeVia([pickup, ...ordered]);
    const codStops = grid.codEnabled ? ordered.filter((s) => s.cod).length : 0;
    const inAbidjan = allInGrandAbidjan([pickup, ...ordered]);
    const sur = this.surcharge.context([pickup, ...ordered]);
    const offers = (Object.keys(grid.vehicles) as VehicleType[])
      .filter((vehicle) => grid.vehicles[vehicle].enabled)
      .map((vehicle) => ({
      vehicle,
      label: grid.vehicles[vehicle].label,
      description: grid.vehicles[vehicle].description,
      prices: Object.fromEntries(
        (Object.keys(grid.speeds) as DeliverySpeed[]).map((s) => [
          s,
          computePrice(grid, route.distanceKm, vehicle, s, ordered.length, codStops, { inAbidjan, surchargePct: sur.pct }),
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
      speeds: grid.speeds,
      codEnabled: grid.codEnabled,
      codFee: grid.codFee,
      extraStopFee: grid.extraStopFee,
      inAbidjan,
      /** Majorations en cours (heure de pointe, nuit, pluie, zone inondable) */
      surcharges: sur.items,
      surchargePct: sur.pct,
      /** Réduction tournée appliquée (%) */
      stopDiscountPct: stopDiscountPct(grid, ordered.length),
    };
  }

  /** « Prise en charge ~X min » : temps d'arrivée du livreur en ligne le plus proche */
  /**
   * Livreurs en ligne autour d'un point (carte du client) : positions seulement, sans identité.
   * [companyId] : uniquement les livreurs de l'entreprise choisie.
   */
  @Get('drivers')
  async nearbyDrivers(@Query('lat') latStr: string, @Query('lng') lngStr: string, @Query('companyId') companyId?: string) {
    const lat = Number(latStr);
    const lng = Number(lngStr);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
    const drivers = await this.users.find({
      where: { role: Role.DRIVER, active: true, lastLocationAt: MoreThan(new Date(Date.now() - ONLINE_WINDOW_MS)), ...(companyId ? { companyId } : {}) },
      relations: { company: true },
    });
    return drivers
      .filter((d) => d.company?.active !== false && d.lastLat != null && d.lastLng != null)
      .map((d) => ({ d, km: haversineKm(lat, lng, d.lastLat!, d.lastLng!) }))
      .filter((x) => x.km <= 8)
      .sort((a, b) => a.km - b.km)
      .slice(0, 40)
      .map(({ d, km }, i) => ({
        id: `d${i}`, // identifiant anonyme (pas d'identité du livreur)
        lat: Math.round(d.lastLat! * 10000) / 10000,
        lng: Math.round(d.lastLng! * 10000) / 10000,
        km: Math.round(km * 10) / 10,
      }));
  }

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
