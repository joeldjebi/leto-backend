import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

const DAY = 86_400_000;

/** Indicateurs du back-office (toute la plateforme pour le SA, une entreprise pour un gérant) */
@Injectable()
export class StatsService {
  constructor(private db: DataSource) {}

  async stats(companyId: string | null, days = 14) {
    const now = new Date();
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())); // Abidjan = UTC
    const since = new Date(today.getTime() - (days - 1) * DAY);
    const weekStart = new Date(today.getTime() - 6 * DAY);
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const scope = companyId ? 'AND d."companyId" = $2' : '';
    const p = (...extra: unknown[]) => (companyId ? [...extra, companyId] : extra);

    // Activité par jour (créées, terminées, volume)
    const rows: { day: string; created: number; delivered: number; volume: number }[] = await this.db.query(
      `SELECT to_char(date_trunc('day', d."createdAt"), 'YYYY-MM-DD') AS day,
              count(*)::int AS created,
              count(*) FILTER (WHERE d.status = 'DELIVERED')::int AS delivered,
              coalesce(sum(d.price) FILTER (WHERE d.status = 'DELIVERED'), 0)::int AS volume
         FROM deliveries d
        WHERE d."createdAt" >= $1 ${scope}
        GROUP BY 1 ORDER BY 1`,
      p(since),
    );
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const series = Array.from({ length: days }, (_, i) => {
      const day = new Date(since.getTime() + i * DAY).toISOString().slice(0, 10);
      return byDay.get(day) ?? { day, created: 0, delivered: 0, volume: 0 };
    });

    const [t] = await this.db.query(
      `SELECT count(*) FILTER (WHERE d.status = 'PENDING')::int AS pending,
              count(*) FILTER (WHERE d.status IN ('ACCEPTED', 'PICKED_UP'))::int AS "inProgress",
              count(*) FILTER (WHERE d."createdAt" >= $1)::int AS "createdToday",
              count(*) FILTER (WHERE d.status = 'DELIVERED' AND d."deliveredAt" >= $1)::int AS "deliveredToday",
              coalesce(sum(d.price) FILTER (WHERE d.status = 'DELIVERED' AND d."deliveredAt" >= $1), 0)::int AS "volumeToday",
              coalesce(sum(d.price) FILTER (WHERE d.status = 'DELIVERED' AND d."deliveredAt" >= $2), 0)::int AS "volumeWeek",
              coalesce(sum(d.price) FILTER (WHERE d.status = 'DELIVERED' AND d."deliveredAt" >= $3), 0)::int AS "volumeMonth",
              count(*) FILTER (WHERE d.status = 'CANCELLED' AND d."createdAt" >= $2)::int AS "cancelledWeek"
         FROM deliveries d
        WHERE true ${companyId ? 'AND d."companyId" = $4' : ''}`,
      companyId ? [today, weekStart, monthStart, companyId] : [today, weekStart, monthStart],
    );

    const [s] = await this.db.query(
      `SELECT count(*) FILTER (WHERE s.status = 'DELIVERED' AND s."deliveredAt" >= $1)::int AS "stopsDelivered",
              count(*) FILTER (WHERE s.status = 'FAILED' AND s."failedAt" >= $1)::int AS "stopsFailed",
              count(*) FILTER (WHERE s."disputedAt" IS NOT NULL AND s."disputeResolvedAt" IS NULL)::int AS "disputesOpen",
              coalesce(sum(s."codAmount") FILTER (WHERE s.status = 'DELIVERED' AND s."codAmount" > 0 AND s."codRemittedAt" IS NULL), 0)::int AS "codToRemit"
         FROM delivery_stops s JOIN deliveries d ON d.id = s."deliveryId"
        WHERE true ${scope}`,
      p(weekStart),
    );

    const [u] = await this.db.query(
      `SELECT count(*) FILTER (WHERE role = 'DRIVER' AND "lastLocationAt" > now() - interval '2 minutes')::int AS "driversOnline",
              count(*) FILTER (WHERE role = 'DRIVER')::int AS drivers,
              count(*) FILTER (WHERE role = 'CLIENT')::int AS clients
         FROM users WHERE true ${companyId ? 'AND "companyId" = $1' : ''}`,
      companyId ? [companyId] : [],
    );
    const [c] = companyId ? [{ companies: 1 }] : await this.db.query(`SELECT count(*)::int AS companies FROM companies WHERE NOT independent`);

    const top = async (sql: string) => this.db.query(sql, p(since));
    const topCompanies = companyId
      ? []
      : await top(`SELECT c.id, c.name, count(*)::int AS delivered, coalesce(sum(d.price), 0)::int AS volume
                     FROM deliveries d JOIN companies c ON c.id = d."companyId"
                    WHERE d.status = 'DELIVERED' AND d."deliveredAt" >= $1
                    GROUP BY c.id, c.name ORDER BY volume DESC LIMIT 5`);
    const topClients = await top(`SELECT u.id, u.name, count(*)::int AS deliveries, coalesce(sum(d.price), 0)::int AS volume
                                    FROM deliveries d JOIN users u ON u.id = d."clientId"
                                   WHERE d."createdAt" >= $1 AND d.status <> 'CANCELLED' ${scope}
                                   GROUP BY u.id, u.name ORDER BY volume DESC LIMIT 5`);

    const handled = s.stopsDelivered + s.stopsFailed;
    return {
      days,
      series,
      totals: { ...t, ...s, ...u, ...c, failureRateWeek: handled ? Math.round((s.stopsFailed / handled) * 1000) / 10 : 0 },
      topCompanies,
      topClients,
    };
  }
}
