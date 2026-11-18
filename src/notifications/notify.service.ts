import { money } from '../countries/phone';
import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { Setting } from '../settings/setting.entity';
import { StorageService } from '../storage/storage.service';
import { TrackingGateway } from '../tracking/tracking.gateway';

/** Événements qui déclenchent une notification (et un son LETO) dans l'app */
export const SOUND_EVENTS = {
  NEW_ORDER: 'Nouvelle course (livreurs)',
  ASSIGNED: 'Course affectée par l’entreprise',
  CANCELLED: 'Course annulée',
  UPDATED: 'Course modifiée (arrêt retiré, ordre changé)',
  CLIENT_UPDATE: 'Suivi de la course (clients)',
} as const;
export type SoundEvent = keyof typeof SOUND_EVENTS;

export interface Sound {
  id: string;
  name: string;
  /** Fichier envoyé par l'admin (/uploads/…) ; null = son intégré à l'app */
  url: string | null;
  builtin: boolean;
}

/** Les 3 sons LETO intégrés à l'app */
const BUILTIN: Sound[] = [
  { id: 'leto_course', name: 'LETO · Nouvelle course', url: null, builtin: true },
  { id: 'leto_affectation', name: 'LETO · Affectation', url: null, builtin: true },
  { id: 'leto_alerte', name: 'LETO · Alerte', url: null, builtin: true },
];

const DEFAULT_EVENTS: Record<SoundEvent, string> = {
  NEW_ORDER: 'leto_course',
  ASSIGNED: 'leto_affectation',
  CANCELLED: 'leto_alerte',
  UPDATED: 'leto_alerte',
  CLIENT_UPDATE: 'leto_affectation',
};

interface SoundsConfig {
  custom: Sound[];
  events: Record<SoundEvent, string>;
}

const KEY = 'sounds';
/** Livreurs considérés en ligne (dernière position GPS) */
const ONLINE_MS = 10 * 60_000;
/** Rayon des livreurs prévenus d'une nouvelle course */
const RADIUS_KM = 10;

/** Notifications du back-office : catégorie (filtrable par l'utilisateur) et son joué */
export const OFFICE_KINDS = {
  NEW_ORDER: { label: 'Nouvelles commandes', sound: 'NEW_ORDER' },
  ACCEPTED: { label: 'Courses acceptées', sound: 'ASSIGNED' },
  DECLINED: { label: 'Affectations refusées', sound: 'CANCELLED' },
  FINISHED: { label: 'Tournées terminées', sound: 'CLIENT_UPDATE' },
  FAILED: { label: 'Livraisons non effectuées', sound: 'UPDATED' },
  CANCELLED: { label: 'Annulations', sound: 'CANCELLED' },
  CANCEL_REQUEST: { label: 'Annulations signalées par les livreurs', sound: 'UPDATED' },
  DISPUTE: { label: 'Litiges', sound: 'CANCELLED' },
  CREDIT_LOW: { label: 'Crédit insuffisant', sound: 'CANCELLED' },
  PAYMENT: { label: 'Paiements', sound: 'ASSIGNED' },
  REMITTANCE: { label: 'Versements des livreurs', sound: 'CLIENT_UPDATE' },
  COMPANY_APPLY: { label: 'Demandes des entreprises', sound: 'ASSIGNED' },
  INDEPENDENT: { label: 'Dossiers des livreurs indépendants', sound: 'ASSIGNED' },
} as const satisfies Record<string, { label: string; sound: SoundEvent }>;
export type OfficeKind = keyof typeof OFFICE_KINDS;

export interface NotifyPayload {
  title: string;
  body: string;
  deliveryId?: string;
}

/**
 * Notifications de l'app, envoyées par la connexion temps réel (Socket.IO) :
 * le serveur décide qui prévenir et avec quel son ; l'app affiche une notification locale.
 */
@Injectable()
export class NotifyService implements OnModuleInit {
  private logger = new Logger(NotifyService.name);
  private cfg: SoundsConfig = { custom: [], events: { ...DEFAULT_EVENTS } };

  constructor(
    private db: DataSource,
    @InjectRepository(Setting) private settings: Repository<Setting>,
    private tracking: TrackingGateway,
    private storage: StorageService,
  ) {}

  async onModuleInit() {
    const row = await this.settings.findOneBy({ key: KEY });
    if (row) {
      const v = row.value as Partial<SoundsConfig>;
      this.cfg = { custom: v.custom ?? [], events: { ...DEFAULT_EVENTS, ...(v.events ?? {}) } };
    }
  }

  // ---------- Sons ----------

  get sounds() {
    return { sounds: [...BUILTIN, ...this.cfg.custom], events: this.cfg.events, labels: SOUND_EVENTS };
  }

  private sound(event: SoundEvent): Sound {
    const id = this.cfg.events[event];
    return [...BUILTIN, ...this.cfg.custom].find((s) => s.id === id) ?? BUILTIN.find((s) => s.id === DEFAULT_EVENTS[event])!;
  }

  private async save(by: string) {
    await this.settings.save({ key: KEY, value: this.cfg, updatedBy: by });
    this.tracking.server?.emit('sounds:changed', {});
    return this.sounds;
  }

  async setEvents(events: Partial<Record<string, string>>, by: string) {
    const ids = new Set([...BUILTIN, ...this.cfg.custom].map((s) => s.id));
    for (const [k, v] of Object.entries(events)) {
      if (!(k in SOUND_EVENTS)) throw new BadRequestException(`Événement inconnu : ${k}`);
      if (!v || !ids.has(v)) throw new BadRequestException('Son inconnu');
      this.cfg.events[k as SoundEvent] = v;
    }
    return this.save(by);
  }

  /** Nouveau son envoyé par l'admin (WAV, court) */
  async addSound(name: string, file: Express.Multer.File | undefined, by: string) {
    if (!file) throw new BadRequestException('Fichier son manquant');
    const isWav = /^audio\/(wav|x-wav|wave|vnd\.wave)$/.test(file.mimetype) || file.originalname?.toLowerCase().endsWith('.wav');
    if (!isWav || file.buffer.subarray(0, 4).toString('ascii') !== 'RIFF') {
      throw new BadRequestException('Format WAV attendu (accepté par Android et iPhone)');
    }
    const seconds = wavSeconds(file.buffer);
    if (seconds === null) throw new BadRequestException('Fichier WAV illisible');
    if (seconds > 10) throw new BadRequestException(`Son trop long (${seconds.toFixed(1)} s) : 10 secondes maximum`);
    if (this.cfg.custom.length >= 20) throw new BadRequestException('20 sons maximum : supprimez-en un');
    const fileName = `${randomUUID()}.wav`;
    await this.storage.save(fileName, file.buffer, 'audio/wav');
    const sound: Sound = { id: `s_${fileName.slice(0, 8)}`, name: name.trim().slice(0, 60) || 'Son', url: `/uploads/${fileName}`, builtin: false };
    this.cfg.custom = [...this.cfg.custom, sound];
    return this.save(by);
  }

  async removeSound(id: string, by: string) {
    const s = this.cfg.custom.find((x) => x.id === id);
    if (!s) throw new NotFoundException('Son introuvable (les sons intégrés ne se suppriment pas)');
    this.cfg.custom = this.cfg.custom.filter((x) => x.id !== id);
    for (const k of Object.keys(this.cfg.events) as SoundEvent[]) {
      if (this.cfg.events[k] === id) this.cfg.events[k] = DEFAULT_EVENTS[k];
    }
    return this.save(by);
  }

  // ---------- Envoi ----------

  /** Notification à des utilisateurs précis (s'ils sont connectés au temps réel) */
  send(userIds: (string | null | undefined)[], event: SoundEvent, p: NotifyPayload) {
    const s = this.sound(event);
    const payload = { id: randomUUID(), type: event, ...p, sound: { id: s.id, url: s.url } };
    for (const id of new Set(userIds.filter((x): x is string => !!x))) this.tracking.emitToUser(id, 'notify', payload);
  }

  /**
   * Notification du back-office (gérants d'une entreprise et/ou Super Admin) : le navigateur
   * l'affiche en notification locale avec le son de l'événement. `link` = route du back-office (#/…).
   */
  office(to: { companyId?: string | null; sa?: boolean }, kind: OfficeKind, p: { title: string; body: string; link?: string; deliveryId?: string }) {
    const s = this.sound(OFFICE_KINDS[kind].sound);
    const payload = { id: randomUUID(), kind, ...p, sound: { id: s.id, url: s.url } };
    const server = this.tracking.server;
    if (!server) return;
    // Les gérants sont dans company:<id> ; le SA dans super-admin (un seul envoi par socket)
    const rooms = [to.companyId ? `company:${to.companyId}` : null, to.sa ? 'super-admin' : null].filter((r): r is string => !!r);
    if (rooms.length) server.to(rooms).emit('office:notify', payload);
  }

  /**
   * Nouvelle course : livreurs en ligne autour du point de départ, selon le choix du client
   * (une entreprise, les livreurs indépendants, ou toutes les entreprises).
   */
  async newOrder(
    d: { id: string; pickupLat: number; pickupLng: number; pickupCommune?: string | null; price: number; targetCompanyId: string | null; forIndependents: boolean },
    stops: number,
  ) {
    try {
      const rows: { id: string }[] = await this.db.query(
        `SELECT u.id FROM users u
           JOIN companies c ON c.id = u."companyId"
           LEFT JOIN independent_profiles p ON p."companyId" = c.id
          WHERE u.role = 'DRIVER' AND u.active AND c.active
            AND u."lastLocationAt" > $1 AND u."lastLat" IS NOT NULL
            AND ($2::uuid IS NULL OR u."companyId" = $2)
            AND (CASE WHEN $3 THEN c.independent AND p.status = 'APPROVED' ELSE NOT c.independent END)
            AND 6371 * 2 * asin(sqrt(power(sin(radians(u."lastLat" - $4) / 2), 2)
                + cos(radians($4)) * cos(radians(u."lastLat")) * power(sin(radians(u."lastLng" - $5) / 2), 2))) <= $6
          LIMIT 100`,
        [new Date(Date.now() - ONLINE_MS), d.targetCompanyId, d.forIndependents, d.pickupLat, d.pickupLng, RADIUS_KM],
      );
      this.send(rows.map((r) => r.id), 'NEW_ORDER', {
        title: `Nouvelle course · ${money(d.price)}`,
        body: `Départ ${d.pickupCommune ?? 'à proximité'}${stops > 1 ? ` · ${stops} arrêts` : ''}`,
        deliveryId: d.id,
      });
    } catch (e) {
      this.logger.warn(`Notification nouvelle course : ${(e as Error).message}`);
    }
  }
}

/** Durée d'un WAV (secondes) d'après son en-tête, null si illisible */
export function wavSeconds(b: Buffer): number | null {
  if (b.length < 44 || b.subarray(8, 12).toString('ascii') !== 'WAVE') return null;
  let off = 12;
  let byteRate = 0;
  while (off + 8 <= b.length) {
    const id = b.subarray(off, off + 4).toString('ascii');
    const size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') byteRate = b.readUInt32LE(off + 16);
    if (id === 'data') return byteRate ? size / byteRate : null;
    off += 8 + size + (size % 2);
  }
  return null;
}
