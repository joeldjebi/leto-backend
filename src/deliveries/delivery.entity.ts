import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Company } from '../companies/company.entity';
import { DeliverySpeed, VehicleType } from '../pricing/pricing';
import { User } from '../users/user.entity';

export enum DeliveryStatus {
  PENDING = 'PENDING', // en attente d'un livreur
  ACCEPTED = 'ACCEPTED', // acceptée, le livreur va au point d'enlèvement
  PICKED_UP = 'PICKED_UP', // colis récupéré, en route
  DELIVERED = 'DELIVERED', // livré (code confirmé)
  CANCELLED = 'CANCELLED', // annulée par le client
}

@Entity('deliveries')
export class Delivery {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => User)
  client: User;
  @Column('uuid')
  clientId: string;

  @ManyToOne(() => User, { nullable: true })
  driver: User | null;
  @Column({ type: 'uuid', nullable: true })
  driverId: string | null;

  @ManyToOne(() => Company, { nullable: true })
  company: Company | null;
  @Column({ type: 'uuid', nullable: true })
  companyId: string | null;

  // Offre
  @Column({ type: 'enum', enum: VehicleType, default: VehicleType.MOTO })
  vehicleType: VehicleType;
  @Column({ type: 'enum', enum: DeliverySpeed, default: DeliverySpeed.STANDARD })
  speed: DeliverySpeed;

  // Enlèvement
  @Column()
  pickupCommune: string;
  /** Nom du lieu / adresse (recherche ou carte) */
  @Column()
  pickupAddress: string;
  /** Précisions : repère, étage, portail… */
  @Column({ type: 'text', nullable: true })
  pickupDetails: string | null;
  @Column({ type: 'text', nullable: true })
  pickupContactName: string | null;
  @Column()
  pickupPhone: string;
  @Column({ type: 'text', nullable: true })
  pickupPhotoUrl: string | null;

  // Destination
  @Column()
  dropoffCommune: string;
  @Column()
  dropoffAddress: string;
  @Column({ type: 'text', nullable: true })
  dropoffDetails: string | null;
  @Column()
  recipientName: string;
  @Column()
  recipientPhone: string;
  @Column({ type: 'text', nullable: true })
  dropoffPhotoUrl: string | null;

  @Column({ type: 'text', nullable: true })
  courierComment: string | null;

  /** Distance et durée de l'itinéraire (calculées à la création) */
  @Column({ type: 'double precision', nullable: true })
  distanceKm: number | null;
  @Column({ type: 'int', nullable: true })
  durationMin: number | null;

  /**
   * Paiement à la livraison : montant de la marchandise que le livreur encaisse
   * auprès du destinataire pour le compte de son entreprise (0 = aucun).
   */
  @Column({ type: 'int', default: 0 })
  codAmount: number;
  /** Date à laquelle l'entreprise a reversé le montant au client (boutique) */
  @Column({ type: 'timestamptz', nullable: true })
  codRemittedAt: Date | null;

  // Coordonnées GPS (choisies sur la carte dans l'app)
  @Column({ type: 'double precision', nullable: true })
  pickupLat: number | null;
  @Column({ type: 'double precision', nullable: true })
  pickupLng: number | null;
  @Column({ type: 'double precision', nullable: true })
  dropoffLat: number | null;
  @Column({ type: 'double precision', nullable: true })
  dropoffLng: number | null;

  @Column({ type: 'text', nullable: true })
  packageDescription: string | null;

  /** Prix de la course en FCFA, payé en espèces (frais de paiement à la livraison inclus) */
  @Column('int')
  price: number;

  @Column({ type: 'enum', enum: DeliveryStatus, default: DeliveryStatus.PENDING })
  status: DeliveryStatus;

  /** Code à 4 chiffres que le destinataire donne au livreur. Masqué par défaut. */
  @Column({ length: 4, select: false })
  confirmationCode: string;

  @Column({ type: 'timestamptz', nullable: true })
  acceptedAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true })
  pickedUpAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true })
  deliveredAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
