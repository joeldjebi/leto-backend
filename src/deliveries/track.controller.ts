import { Controller, Get, Param } from '@nestjs/common';
import { Public } from '../common/decorators';
import { DeliveriesService } from './deliveries.service';

/** Lien de suivi public (partagé au client ou aux destinataires sans l'app) */
@Controller('track')
export class TrackController {
  constructor(private service: DeliveriesService) {}

  @Public()
  @Get(':token')
  track(@Param('token') token: string) {
    return this.service.publicTracking(token);
  }
}
