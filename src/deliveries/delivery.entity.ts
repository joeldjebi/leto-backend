import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Company } from '../companies/company.entity';
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

  // Enlèvement
  @Column()
  pickupCommune: string;
  @Column()
  pickupAddress: string;
  @Column()
  pickupPhone: string;

  // Destination
  @Column()
  dropoffCommune: string;
  @Column()
  dropoffAddress: string;
  @Column()
  recipientName: string;
  @Column()
  recipientPhone: string;

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

  /** Prix en FCFA, payé en espèces au livreur (MVP) */
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
