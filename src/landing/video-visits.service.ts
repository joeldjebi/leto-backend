import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'crypto';
import geoip from 'geoip-lite';
import { MoreThan, Repository } from 'typeorm';
import { NotifyService } from '../notifications/notify.service';
import { VideoVisit } from './video-visit.entity';

/** Provenance d'après le navigateur intégré des applications (WhatsApp, Facebook…) ou la page d'origine */
function sourceOf(ua: string, referrer: string): string | null {
  if (/WhatsApp/i.test(ua)) return 'WhatsApp';
  if (/Instagram/i.test(ua)) return 'Instagram';
  if (/FBAN|FBAV|FB_IAB|FBIOS|Messenger/i.test(ua)) return 'Facebook';
  if (/LinkedInApp/i.test(ua)) return 'LinkedIn';
  if (/Telegram/i.test(ua)) return 'Telegram';
  if (/TikTok|musical_ly|BytedanceWebview/i.test(ua)) return 'TikTok';
  if (/Snapchat/i.test(ua)) return 'Snapchat';
  try {
    const host = referrer ? new URL(referrer).hostname.replace(/^www\./, '') : '';
    if (!host || /(performx\.online|vite\.ci)$/.test(host)) return referrer ? 'Site VITE' : 'Lien direct';
    if (/google\./.test(host)) return 'Google';
    if (/facebook\.com|fb\.com/.test(host)) return 'Facebook';
    if (/linkedin\.com|lnkd\.in/.test(host)) return 'LinkedIn';
    if (/t\.co$|twitter\.com|x\.com/.test(host)) return 'X (Twitter)';
    return host.slice(0, 40);
  } catch {
    return 'Lien direct';
  }
}

function deviceOf(ua: string): { device: string; os: string | null } {
  const os = /iPhone/i.test(ua) ? 'iPhone' : /iPad/i.test(ua) ? 'iPad' : /Android/i.test(ua) ? 'Android' : /Mac OS X|Macintosh/i.test(ua) ? 'Mac' : /Windows/i.test(ua) ? 'Windows' : /Linux/i.test(ua) ? 'Linux' : null;
  const device = /iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua)) ? 'Tablette' : /Mobi|iPhone|Android/i.test(ua) ? 'Téléphone' : 'Ordinateur';
  return { device, os };
}

// Les aperçus de lien (WhatsApp, Facebook…) n'exécutent pas le script de la page : ils ne comptent jamais. Reste les robots qui l'exécutent.
const BOTS = /bot|crawl|spider|headless|lighthouse|puppeteer|playwright/i;

/** Visites de la page vidéo : enregistrées sans donnée personnelle (l'IP sert seulement à déduire le pays, puis est oubliée) */
@Injectable()
export class VideoVisitsService {
  private salt = process.env.JWT_SECRET ?? 'leto';
  /** Anti-abus : une visite par visiteur toutes les 30 s au plus */
  private recent = new Map<string, number>();

  constructor(
    @InjectRepository(VideoVisit) private repo: Repository<VideoVisit>,
    private notify: NotifyService,
  ) {}

  async start(ip: string, ua: string, body: { video?: string; referrer?: string }) {
    // Aperçus de lien (WhatsApp, Facebook…) et robots : pas une vraie visite
    if (!ua || BOTS.test(ua)) return { ok: false };
    const visitor = createHash('sha256').update(`${ip}|${ua}|${this.salt}`).digest('hex');
    const now = Date.now();
    if ((this.recent.get(visitor) ?? 0) > now - 30_000) return { ok: false };
    this.recent.set(visitor, now);
    if (this.recent.size > 5000) this.recent.clear();

    const geo = ip ? geoip.lookup(ip) : null;
    const { device, os } = deviceOf(ua);
    const returning = await this.repo.exists({ where: { visitor } });
    const token = randomBytes(16).toString('hex');
    const v = await this.repo.save(
      this.repo.create({
        country: geo?.country || null,
        city: geo?.city || null,
        device,
        os,
        source: sourceOf(ua, String(body?.referrer ?? '').slice(0, 300)),
        video: body?.video === 'vertical' ? 'vertical' : 'horizontal',
        visitor,
        token,
        lastSeenAt: new Date(),
      }),
    );
    const where = [v.city, v.country ? countryName(v.country) : null].filter(Boolean).join(', ') || 'lieu inconnu';
    this.notify.office({ sa: true }, 'VIDEO_VISIT', {
      title: returning ? 'La vidéo de présentation est revue' : 'Nouvelle visite de la vidéo de présentation',
      body: `${where} · ${device}${os ? ` ${os}` : ''}${v.source ? ` · via ${v.source}` : ''}`,
      link: '#/visites-video',
    });
    return { ok: true, id: v.id, token };
  }

  /** Progression de la lecture (envoyée régulièrement et à la fermeture de la page) */
  async progress(id: string, body: { token?: string; watched?: string | number; duration?: string | number }) {
    const v = await this.repo.findOne({ where: { id }, select: { id: true, token: true, watchedSec: true } }).catch(() => null);
    if (!v || !body?.token || body.token !== v.token) return { ok: false };
    const watched = Math.max(0, Math.min(36_000, Math.round(Number(body.watched) || 0)));
    const duration = Math.round(Number(body.duration) || 0);
    await this.repo.update(id, {
      watchedSec: Math.max(v.watchedSec, watched),
      ...(duration > 0 && duration < 36_000 ? { durationSec: duration } : {}),
      lastSeenAt: new Date(),
    });
    return { ok: true };
  }

  /** Liste pour l'admin : dernières visites et chiffres clés */
  async list() {
    const visits = await this.repo.find({ order: { createdAt: 'DESC' }, take: 300 });
    const week = new Date(Date.now() - 7 * 86_400_000);
    const [total, lastWeek, uniq, avg] = await Promise.all([
      this.repo.count(),
      this.repo.count({ where: { createdAt: MoreThan(week) } }),
      this.repo.createQueryBuilder('v').select('COUNT(DISTINCT v.visitor)', 'n').getRawOne<{ n: string }>(),
      this.repo.createQueryBuilder('v').select('AVG(v.watchedSec)', 'a').where('v.watchedSec > 0').getRawOne<{ a: string | null }>(),
    ]);
    const firstSeen = new Map<string, Date>();
    for (const v of [...visits].reverse()) if (!firstSeen.has(v.visitor)) firstSeen.set(v.visitor, v.createdAt);
    return {
      stats: { total, lastWeek, visitors: Number(uniq?.n ?? 0), avgWatchedSec: avg?.a ? Math.round(Number(avg.a)) : 0 },
      visits: visits.map(({ visitor, ...v }) => ({ ...v, returning: firstSeen.get(visitor)! < v.createdAt })),
    };
  }
}

export function countryName(code: string) {
  try {
    return new Intl.DisplayNames(['fr'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}
