import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { User } from '../users/user.entity';

export enum LogbookStatus {
  TODO = 'TODO', // à livrer
  DELIVERED = 'DELIVERED',
  FAILED = 'FAILED', // pas livré (absent, refus…)
  CANCELLED = 'CANCELLED', // annulée par le livreur (erreur de saisie, commande annulée)
}

/** Une ligne de l'historique : création, modification, changement de statut */
export interface LogbookEvent {
  at: string;
  action: 'CREATED' | 'UPDATED' | 'STATUS';
  status?: LogbookStatus;
  changes?: Record<string, { from: unknown; to: unknown }>;
  note?: string;
}

/**
 * Carnet du livreur : livraisons qu'il enregistre lui-même (remplace le bout de papier) —
 * adresse, numéro du destinataire, prix et photo du colis prise sur place.
 */
@Entity('logbook_entries')
export class LogbookEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  driver: User;
  @Index()
  @Column('uuid')
  driverId: string;

  /** Entreprise du livreur au moment de la saisie */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  companyId: string | null;

  @Column()
  address: string;
  @Column({ type: 'double precision', nullable: true })
  lat: number | null;
  @Column({ type: 'double precision', nullable: true })
  lng: number | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  recipientName: string | null;
  @Column({ type: 'varchar', length: 20 })
  recipientPhone: string;

  /** Prix de la livraison (FCFA) */
  @Column('int')
  price: number;
  /** Devise du prix (pays où LETO livre, figée à la saisie) */
  @Column({ type: 'varchar', length: 3, default: 'XOF' })
  currency: string;

  /** Photo du colis, prise avec l'appareil photo */
  @Column()
  photoUrl: string;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @Column({ type: 'varchar', length: 12, default: LogbookStatus.TODO })
  status: LogbookStatus;

  @Column({ type: 'timestamptz', nullable: true })
  doneAt: Date | null;

  /** Ordre de passage choisi par le livreur (null = trié par le plus proche) */
  @Column({ type: 'int', nullable: true })
  sortOrder: number | null;

  /** Historique complet, visible par l'entreprise */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  history: LogbookEvent[];

  @Index()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
