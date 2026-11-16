import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Company } from '../companies/company.entity';
import { DeliverySpeed, VehicleType } from '../pricing/pricing';
import { User } from '../users/user.entity';
import { DeliveryStop } from './delivery-stop.entity';

export enum DeliveryStatus {
  PENDING = 'PENDING', // en attente d'un livreur
  ACCEPTED = 'ACCEPTED', // acceptée, le livreur va au point d'enlèvement
  PICKED_UP = 'PICKED_UP', // colis récupérés, tournée en cours
  DELIVERED = 'DELIVERED', // terminée (tous les arrêts livrés ou en échec)
  CANCELLED = 'CANCELLED', // annulée par le client
}

/**
 * Une course = un point de départ et un ou plusieurs arrêts (tournée).
 * Payée en espèces par l'expéditeur (particulier ou boutique).
 */
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

  // Départ
  @Column()
  pickupCommune: string;
  @Column()
  pickupAddress: string;
  @Column({ type: 'text', nullable: true })
  pickupDetails: string | null;
  @Column({ type: 'text', nullable: true })
  pickupContactName: string | null;
  @Column()
  pickupPhone: string;
  @Column({ type: 'text', nullable: true })
  pickupPhotoUrl: string | null;
  @Column({ type: 'double precision' })
  pickupLat: number;
  @Column({ type: 'double precision' })
  pickupLng: number;

  /** Arrêts dans l'ordre de passage (optimisé) */
  @OneToMany(() => DeliveryStop, (s) => s.delivery, { cascade: true })
  stops: DeliveryStop[];

  @Column({ type: 'text', nullable: true })
  courierComment: string | null;

  /** Itinéraire complet départ → arrêts (calculé à la création) */
  @Column({ type: 'double precision', nullable: true })
  distanceKm: number | null;
  @Column({ type: 'int', nullable: true })
  durationMin: number | null;

  /** Prix total en FCFA, payé en espèces par l'expéditeur */
  @Column('int')
  price: number;

  /** Commission LETO (fixée à l'acceptation, prélevée sur le crédit de l'entreprise à la fin de la tournée) */
  @Column({ type: 'int', nullable: true })
  commissionAmount: number | null;
  @Column({ type: 'text', nullable: true })
  commissionRule: string | null;
  @Column({ type: 'timestamptz', nullable: true })
  commissionChargedAt: Date | null;
  /** Part remboursée après un litige donné au client */
  @Column({ type: 'int', default: 0 })
  commissionRefunded: number;

  @Column({ type: 'enum', enum: DeliveryStatus, default: DeliveryStatus.PENDING })
  status: DeliveryStatus;

  @Column({ type: 'timestamptz', nullable: true })
  acceptedAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true })
  pickedUpAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true })
  deliveredAt: Date | null;

  /** Annulation (par le client, ou par le SA avec un motif) */
  @Column({ type: 'timestamptz', nullable: true })
  cancelledAt: Date | null;
  @Column({ type: 'text', nullable: true })
  cancelReason: string | null;
  @Column({ type: 'text', nullable: true })
  cancelledBy: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
