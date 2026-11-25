import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export const ALERT_OUTCOMES = ['PENDING', 'ACCEPTED', 'PROPOSED', 'DECLINED', 'EXPIRED', 'TAKEN'] as const;
/**
 * PENDING : alerte affichée, pas encore de réponse · ACCEPTED : course acceptée · PROPOSED : prix proposé ·
 * DECLINED : refusée · EXPIRED : sans réponse à temps · TAKEN : prise par un autre livreur avant sa réponse
 */
export type AlertOutcome = (typeof ALERT_OUTCOMES)[number];

/** Alerte « nouvelle course » envoyée à un livreur, et sa réponse (statistiques de réactivité) */
@Entity('order_alerts')
@Index(['deliveryId', 'driverId'], { unique: true })
@Index(['driverId', 'sentAt'])
export class OrderAlert {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  deliveryId: string;
  @Column('uuid')
  driverId: string;
  @Column({ type: 'uuid', nullable: true })
  companyId: string | null;

  /** Vague d'envoi (1 = les livreurs les plus proches) */
  @Column({ type: 'smallint', default: 1 })
  wave: number;
  /** Livreur libre (FREE), ou déjà en course : départ sur son trajet (ROUTE) ou près de lui (NEARBY) */
  @Column({ type: 'varchar', length: 8, default: 'FREE' })
  kind: 'FREE' | 'ROUTE' | 'NEARBY';
  /** Distance du livreur au départ (km) */
  @Column({ type: 'double precision', nullable: true })
  km: number | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  sentAt: Date;
  @Column({ type: 'varchar', length: 10, default: 'PENDING' })
  outcome: AlertOutcome;
  @Column({ type: 'timestamptz', nullable: true })
  respondedAt: Date | null;
  /** Temps de réaction (ms) entre l'alerte et la réponse du livreur */
  @Column({ type: 'int', nullable: true })
  reactionMs: number | null;
}
