import { Column, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Delivery } from './delivery.entity';

export enum StopStatus {
  PENDING = 'PENDING',
  DELIVERED = 'DELIVERED',
  FAILED = 'FAILED', // destinataire absent ou refus
  CANCELLED = 'CANCELLED', // annulé par l'expéditeur (ou à la demande du destinataire, confirmée)
}

/** Décision sur une contestation : donnée en faveur de l'expéditeur (UPHELD) ou du livreur (REJECTED) */
export enum DisputeDecision {
  UPHELD = 'UPHELD',
  REJECTED = 'REJECTED',
}

export enum FailureReason {
  ABSENT = 'ABSENT', // personne sur place / injoignable (attente obligatoire)
  REFUSED = 'REFUSED', // le destinataire refuse le colis
}

/** Un arrêt d'une course : un destinataire, son code, son éventuel montant à encaisser */
@Entity('delivery_stops')
export class DeliveryStop {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Delivery, (d) => d.stops, { onDelete: 'CASCADE' })
  delivery: Delivery;
  @Column('uuid')
  deliveryId: string;

  /** Ordre de passage (0 = premier arrêt) */
  @Column('int')
  position: number;

  // Adresse
  @Column()
  address: string;
  @Column()
  commune: string;
  @Column({ type: 'text', nullable: true })
  details: string | null;
  @Column({ type: 'double precision' })
  lat: number;
  @Column({ type: 'double precision' })
  lng: number;
  @Column({ type: 'text', nullable: true })
  photoUrl: string | null;

  // Destinataire
  @Column()
  recipientName: string;
  @Column()
  recipientPhone: string;
  @Column({ type: 'text', nullable: true })
  packageDescription: string | null;

  /** Paiement à la livraison : montant encaissé pour l'entreprise (0 = aucun) */
  @Column({ type: 'int', default: 0 })
  codAmount: number;
  @Column({ type: 'timestamptz', nullable: true })
  codRemittedAt: Date | null;

  /** Code à 4 chiffres partagé par l'expéditeur au destinataire. Masqué par défaut. */
  @Column({ length: 4, select: false })
  confirmationCode: string;

  @Column({ type: 'enum', enum: StopStatus, default: StopStatus.PENDING })
  status: StopStatus;

  /** Le livreur est arrivé à moins de 150 m (détecté par GPS, côté serveur) */
  @Column({ type: 'timestamptz', nullable: true })
  arrivedAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true })
  deliveredAt: Date | null;

  // Échec (preuves : position GPS, photo, attente)
  @Column({ type: 'timestamptz', nullable: true })
  failedAt: Date | null;
  @Column({ type: 'enum', enum: FailureReason, nullable: true })
  failureReason: FailureReason | null;
  @Column({ type: 'text', nullable: true })
  failurePhotoUrl: string | null;
  @Column({ type: 'text', nullable: true })
  failureNote: string | null;
  @Column({ type: 'double precision', nullable: true })
  failureLat: number | null;
  @Column({ type: 'double precision', nullable: true })
  failureLng: number | null;

  /** Contestation de l'expéditeur (litige à traiter par l'entreprise / le SA) */
  @Column({ type: 'timestamptz', nullable: true })
  disputedAt: Date | null;
  @Column({ type: 'text', nullable: true })
  disputeNote: string | null;

  /** Arbitrage du litige (entreprise ou SA) */
  @Column({ type: 'enum', enum: DisputeDecision, nullable: true })
  disputeDecision: DisputeDecision | null;
  @Column({ type: 'text', nullable: true })
  disputeResolutionNote: string | null;
  @Column({ type: 'text', nullable: true })
  disputeResolvedBy: string | null;
  @Column({ type: 'timestamptz', nullable: true })
  disputeResolvedAt: Date | null;

  // Annulation de l'arrêt
  @Column({ type: 'timestamptz', nullable: true })
  cancelledAt: Date | null;
  /** Qui a annulé : « Client », « Livreur (confirmé par le client) », « Automatique » */
  @Column({ type: 'text', nullable: true })
  cancelledBy: string | null;
  @Column({ type: 'text', nullable: true })
  cancelReason: string | null;
  /** Le livreur signale que le destinataire annule : en attente de confirmation de l'expéditeur */
  @Column({ type: 'timestamptz', nullable: true })
  cancelRequestedAt: Date | null;
  @Column({ type: 'text', nullable: true })
  cancelRequestNote: string | null;
}
