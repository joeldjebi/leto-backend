import { BadRequestException, Body, Controller, Delete, Get, Injectable, Logger, NotFoundException, OnApplicationBootstrap, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { Repository } from 'typeorm';
import { AuthUser, CurrentUser, Roles } from '../common/decorators';
import { Role, User } from '../users/user.entity';
import { Prospect, PROSPECT_STATUSES, ProspectEvent, ProspectStatus } from './prospect.entity';
import { messagesFor } from './messages';
import { PROSPECT_SEED } from './seed';

const STATUS_LABEL: Record<ProspectStatus, string> = {
  TODO: 'À contacter', CONTACTED: 'Contacté', FOLLOW_UP: 'À relancer', MEETING: 'Rendez-vous', DEMO: 'Démo faite', WON: 'Client', LOST: 'Pas intéressé',
};

/** Champs modifiables d'un prospect (tous facultatifs ; null ou "" efface) */
export class ProspectDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(8) country?: string;
  @IsOptional() @ValidateIf((o) => o.city !== null) @IsString() @MaxLength(120) city?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(3) priority?: number;
  @IsOptional() @ValidateIf((o) => o.description !== null) @IsString() @MaxLength(300) description?: string | null;
  @IsOptional() @ValidateIf((o) => o.website !== null) @IsString() @MaxLength(300) website?: string | null;
  @IsOptional() @ValidateIf((o) => o.phone !== null) @IsString() @MaxLength(30) phone?: string | null;
  @IsOptional() @ValidateIf((o) => o.whatsapp !== null) @IsString() @MaxLength(30) whatsapp?: string | null;
  @IsOptional() @ValidateIf((o) => o.email !== null) @IsString() @MaxLength(160) email?: string | null;
  @IsOptional() @ValidateIf((o) => o.facebook !== null) @IsString() @MaxLength(300) facebook?: string | null;
  @IsOptional() @ValidateIf((o) => o.instagram !== null) @IsString() @MaxLength(300) instagram?: string | null;
  @IsOptional() @ValidateIf((o) => o.linkedin !== null) @IsString() @MaxLength(300) linkedin?: string | null;
  @IsOptional() @ValidateIf((o) => o.contactName !== null) @IsString() @MaxLength(160) contactName?: string | null;
  @IsOptional() @IsIn(PROSPECT_STATUSES as unknown as string[]) status?: ProspectStatus;
  @IsOptional() @ValidateIf((o) => o.nextActionAt !== null) @IsISO8601() nextActionAt?: string | null;
  @IsOptional() @ValidateIf((o) => o.nextAction !== null) @IsString() @MaxLength(200) nextAction?: string | null;
  @IsOptional() @ValidateIf((o) => o.notes !== null) @IsString() @MaxLength(5000) notes?: string | null;
  @IsOptional() @ValidateIf((o) => o.waMessage !== null) @IsString() @MaxLength(3000) waMessage?: string | null;
  @IsOptional() @ValidateIf((o) => o.emailSubject !== null) @IsString() @MaxLength(200) emailSubject?: string | null;
  @IsOptional() @ValidateIf((o) => o.emailBody !== null) @IsString() @MaxLength(5000) emailBody?: string | null;
}

/** Une entrée d'historique : prise de contact (met à jour « dernier contact ») ou simple note */
export class ProspectLogDto {
  @IsIn(['NOTE', 'CONTACT']) kind: 'NOTE' | 'CONTACT';
  @IsString() @MaxLength(1000) text: string;
}

@Injectable()
export class ProspectsService implements OnApplicationBootstrap {
  private readonly logger = new Logger('Prospects');
  constructor(@InjectRepository(Prospect) private repo: Repository<Prospect>) {}

  /** Au démarrage : messages personnalisés pour les entreprises de la liste de départ qui n'en ont pas encore */
  async onApplicationBootstrap() {
    try {
      const todo = (await this.repo.find({ select: { id: true, name: true, waMessage: true } })).filter((p) => !p.waMessage && messagesFor(p.name));
      for (const p of todo) await this.repo.update(p.id, messagesFor(p.name)!);
      if (todo.length) this.logger.log(`Messages personnalisés ajoutés à ${todo.length} prospect(s)`);
    } catch (e) {
      this.logger.warn(`Messages personnalisés non ajoutés : ${(e as Error).message}`);
    }
  }

  list() {
    return this.repo.find({ order: { priority: 'ASC', name: 'ASC' } });
  }

  private clean(dto: ProspectDto): Partial<Prospect> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(dto)) {
      if (v === undefined) continue;
      if (k === 'nextActionAt') out[k] = v ? new Date(v as string) : null;
      else out[k] = typeof v === 'string' ? v.trim() || (k === 'name' ? v : null) : v;
    }
    return out as Partial<Prospect>;
  }

  async create(dto: ProspectDto, by: string) {
    if (!dto.name?.trim()) throw new BadRequestException('Nom de l’entreprise obligatoire');
    const p = this.repo.create({ ...this.clean(dto), history: [{ at: new Date().toISOString(), kind: 'NOTE', text: 'Ajouté à la prospection', by }] });
    return this.repo.save(p);
  }

  async update(id: string, dto: ProspectDto, by: string) {
    const p = await this.repo.findOneBy({ id });
    if (!p) throw new NotFoundException('Prospect introuvable');
    const changes = this.clean(dto);
    if (changes.name !== undefined && !String(changes.name).trim()) throw new BadRequestException('Nom de l’entreprise obligatoire');
    const history = [...(p.history ?? [])];
    if (changes.status && changes.status !== p.status) {
      history.push({ at: new Date().toISOString(), kind: 'STATUS', text: `${STATUS_LABEL[p.status]} → ${STATUS_LABEL[changes.status]}`, by });
      // Passer à « Contacté » enregistre la prise de contact
      if (changes.status === 'CONTACTED' && !dto.nextActionAt) changes.lastContactAt = new Date();
    }
    Object.assign(p, changes, { history });
    return this.repo.save(p);
  }

  async log(id: string, dto: ProspectLogDto, by: string) {
    const p = await this.repo.findOneBy({ id });
    if (!p) throw new NotFoundException('Prospect introuvable');
    const text = dto.text.trim();
    if (!text) throw new BadRequestException('Écrivez une note');
    const ev: ProspectEvent = { at: new Date().toISOString(), kind: dto.kind, text, by };
    p.history = [...(p.history ?? []), ev];
    if (dto.kind === 'CONTACT') {
      p.lastContactAt = new Date();
      if (p.status === 'TODO') p.status = 'CONTACTED';
    }
    return this.repo.save(p);
  }

  async remove(id: string) {
    const res = await this.repo.delete({ id });
    if (!res.affected) throw new NotFoundException('Prospect introuvable');
    return { ok: true };
  }

  /** Liste de départ (entreprises de livraison d'Abidjan et de la sous-région) : ajoute celles qui manquent */
  async seed(by: string) {
    const existing = new Set((await this.repo.find({ select: { name: true } })).map((p) => p.name.toLowerCase()));
    const missing = PROSPECT_SEED.filter((p) => !existing.has(p.name.toLowerCase()));
    if (missing.length) {
      await this.repo.save(
        missing.map((p) => this.repo.create({ ...p, ...(messagesFor(p.name) ?? {}), history: [{ at: new Date().toISOString(), kind: 'NOTE', text: 'Importé de la liste de départ', by }] })),
      );
    }
    return { added: missing.length };
  }
}

@Controller('admin/prospects')
@Roles(Role.SUPER_ADMIN)
export class ProspectsController {
  constructor(
    private service: ProspectsService,
    @InjectRepository(User) private users: Repository<User>,
  ) {}

  private async by(user: AuthUser) {
    return (await this.users.findOneBy({ id: user.sub }))?.name ?? 'Admin';
  }

  @Get()
  list() {
    return this.service.list();
  }

  @Post()
  async create(@CurrentUser() user: AuthUser, @Body() dto: ProspectDto) {
    return this.service.create(dto, await this.by(user));
  }

  @Post('seed')
  async seed(@CurrentUser() user: AuthUser) {
    return this.service.seed(await this.by(user));
  }

  @Patch(':id')
  async update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ProspectDto) {
    return this.service.update(id, dto, await this.by(user));
  }

  @Post(':id/log')
  async log(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ProspectLogDto) {
    return this.service.log(id, dto, await this.by(user));
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(id);
  }
}
