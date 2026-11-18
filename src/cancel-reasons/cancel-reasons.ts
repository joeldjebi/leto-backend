import { BadRequestException, Body, Controller, Get, Injectable, OnModuleInit, Put } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthUser, CurrentUser, Roles } from '../common/decorators';
import { Setting } from '../settings/setting.entity';
import { TrackingGateway } from '../tracking/tracking.gateway';
import { Role, User } from '../users/user.entity';

/** Motifs d'annulation proposés dans l'app et le back-office (toujours avec « Autre » en texte libre) */
export interface CancelReasons {
  /** Le client annule une course ou un arrêt */
  client: string[];
  /** Le livreur (ou l'entreprise de livraison) demande l'annulation d'un arrêt ou d'une course */
  driver: string[];
}

const DEFAULT: CancelReasons = {
  client: [
    'Je me suis trompé d’adresse',
    'Le destinataire n’est plus disponible',
    'Commande annulée par mon client',
    'J’ai trouvé une autre solution de livraison',
    'Le livreur met trop de temps à arriver',
    'Le prix ne me convient pas',
  ],
  driver: [
    'Le destinataire refuse le colis',
    'Le destinataire demande un report',
    'Adresse introuvable ou inaccessible',
    'Colis non conforme ou endommagé',
    'Problème avec mon engin',
    'L’expéditeur a annulé par téléphone',
  ],
};

const KEY = 'cancelReasons';

@Injectable()
export class CancelReasonsService implements OnModuleInit {
  private value: CancelReasons = structuredClone(DEFAULT);
  constructor(
    @InjectRepository(Setting) private settings: Repository<Setting>,
    private tracking: TrackingGateway,
  ) {}

  async onModuleInit() {
    const row = await this.settings.findOneBy({ key: KEY });
    if (row) this.value = { ...structuredClone(DEFAULT), ...(row.value as Partial<CancelReasons>) };
  }

  get(): CancelReasons {
    return this.value;
  }

  async update(input: Partial<CancelReasons>, by: string) {
    const clean = (list: unknown, who: string) => {
      if (!Array.isArray(list)) throw new BadRequestException(`Motifs ${who} : liste attendue`);
      const out = [...new Set(list.map((x) => String(x ?? '').trim()).filter(Boolean))];
      if (!out.length) throw new BadRequestException(`Motifs ${who} : au moins un motif`);
      if (out.length > 15) throw new BadRequestException(`Motifs ${who} : 15 au maximum`);
      if (out.some((x) => x.length > 80)) throw new BadRequestException(`Motifs ${who} : 80 caractères maximum chacun`);
      return out;
    };
    const next: CancelReasons = {
      client: input.client !== undefined ? clean(input.client, 'client') : this.value.client,
      driver: input.driver !== undefined ? clean(input.driver, 'livreur') : this.value.driver,
    };
    await this.settings.save({ key: KEY, value: next, updatedBy: by });
    this.value = next;
    this.tracking.server?.emit('settings:changed', {});
    return next;
  }

  reset(by: string) {
    return this.update(structuredClone(DEFAULT), by);
  }
}

@Controller()
export class CancelReasonsController {
  constructor(
    private service: CancelReasonsService,
    @InjectRepository(User) private users: Repository<User>,
  ) {}

  /** Motifs proposés (app et back-office) */
  @Get('cancel-reasons')
  list() {
    return this.service.get();
  }

  @Put('admin/cancel-reasons')
  @Roles(Role.SUPER_ADMIN)
  async update(@CurrentUser() user: AuthUser, @Body() body: Partial<CancelReasons>) {
    const me = await this.users.findOneBy({ id: user.sub });
    return this.service.update(body ?? {}, me?.name ?? 'Super Admin');
  }
}
