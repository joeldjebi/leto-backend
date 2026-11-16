import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { GeoService } from './geo.service';

const num = (v: string, name: string) => {
  const n = Number(v);
  if (v === undefined || v === '' || !Number.isFinite(n)) throw new BadRequestException(`${name} invalide`);
  return n;
};

/** Recherche de lieux, adresse d'un point, itinéraire (utilisateurs connectés) */
@Controller('geo')
export class GeoController {
  constructor(private geo: GeoService) {}

  @Get('search')
  search(@Query('q') q = '', @Query('lat') lat?: string, @Query('lng') lng?: string) {
    const near = lat && lng ? { lat: num(lat, 'lat'), lng: num(lng, 'lng') } : undefined;
    return this.geo.search(q, near);
  }

  @Get('reverse')
  reverse(@Query('lat') lat: string, @Query('lng') lng: string) {
    return this.geo.reverse(num(lat, 'lat'), num(lng, 'lng'));
  }

  @Get('route')
  route(
    @Query('fromLat') fromLat: string,
    @Query('fromLng') fromLng: string,
    @Query('toLat') toLat: string,
    @Query('toLng') toLng: string,
  ) {
    return this.geo.route(
      { lat: num(fromLat, 'fromLat'), lng: num(fromLng, 'fromLng') },
      { lat: num(toLat, 'toLat'), lng: num(toLng, 'toLng') },
    );
  }
}
