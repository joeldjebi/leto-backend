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
  ABSENT = 'ABSENT', // personne sur place / injoignable (appel et attente obligatoires)
  REFUSED = 'REFUSED', // le destinataire refuse le colis
  WRONG_ADDRESS = 'WRONG_ADDRESS', // adresse introuvable ou erronée
  NO_MONEY = 'NO_MONEY', // paiement à la livraison : le destinataire n'a pas l'argent
  DAMAGED = 'DAMAGED', // colis abîmé, refusé à juste titre
  UNSAFE = 'UNSAFE', // lieu dangereux ou inaccessible
}

/** Après un échec : l'expéditeur choisit (DECIDING), puis nouvelle tentative (RETRY) ou retour (RETURN) */
export enum FollowUp {
  DECIDING = 'DECIDING',
  RETRY = 'RETRY',
  RETURN = 'RETURN',
}

/** Une nouvelle tentative au plus par colis (2 passages) */
export const MAX_ATTEMPTS = 2;

/** Tentative précédente (gardée quand l'expéditeur demande une nouvelle tentative) */
export interface PastAttempt {
  failedAt: string;
  reason: FailureReason;
  photoUrl: string | null;
  note: string | null;
  address: string;
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

  /** Livraison payée par le destinataire : sa part du prix, encaissée à la remise */
  @Column({ type: 'int', default: 0 })
  feeDue: number;

  /** Colis remis seulement après confirmation du paiement de la marchandise (partenaire, ex. PI-SPI) */
  @Column({ default: false })
  paymentRequired: boolean;
  @Column({ type: 'timestamptz', nullable: true })
  paymentConfirmedAt: Date | null;

  @Column({ type: 'enum', enum: StopStatus, default: StopStatus.PENDING })
  status: StopStatus;

  /** Le livreur est passé à moins de 1 km : expéditeur et destinataire prévenus (push) */
  @Column({ type: 'timestamptz', nullable: true })
  approachNotifiedAt: Date | null;
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

  // Appels du livreur au destinataire (obligatoires avant de partir avec les colis, et avant une absence)
  @Column({ type: 'timestamptz', nullable: true })
  calledAt: Date | null;
  @Column({ type: 'int', default: 0 })
  callCount: number;

  /** Sur place, destinataire injoignable : le livreur demande à l'expéditeur quoi faire */
  @Column({ type: 'timestamptz', nullable: true })
  helpRequestedAt: Date | null;
  /** Réponse de l'expéditeur (« Attendre 5 min de plus », « Nouveau numéro… ») */
  @Column({ type: 'text', nullable: true })
  helpAnswer: string | null;
  /** L'expéditeur demande d'attendre : absence impossible avant cette heure */
  @Column({ type: 'timestamptz', nullable: true })
  waitUntil: Date | null;

  /** Passage n° (1 = premier, 2 = nouvelle tentative) */
  @Column({ type: 'int', default: 1 })
  attempt: number;
  @Column({ type: 'jsonb', nullable: true })
  pastAttempts: PastAttempt[] | null;
  /** Suite donnée à l'échec */
  @Column({ type: 'enum', enum: FollowUp, nullable: true })
  followUp: FollowUp | null;
  /** Sans choix de l'expéditeur avant cette heure : retour automatique */
  @Column({ type: 'timestamptz', nullable: true })
  followUpDeadline: Date | null;
  @Column({ type: 'text', nullable: true })
  followUpBy: string | null;

  /** Frais dus par l'expéditeur pour cet arrêt : retour du colis, nouvelle tentative */
  @Column({ type: 'int', default: 0 })
  returnFee: number;
  @Column({ type: 'int', default: 0 })
  retryFee: number;

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
