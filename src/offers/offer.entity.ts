import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Company } from '../companies/company.entity';
import { Delivery } from '../deliveries/delivery.entity';
import { User } from '../users/user.entity';

export enum OfferStatus {
  PENDING = 'PENDING', // en attente de la réponse du client
  ACCEPTED = 'ACCEPTED',
  REJECTED = 'REJECTED', // refusée, remplacée, ou course prise par un autre
}

/** « Proposez votre prix » : contre-proposition d'un livreur sur une course en attente */
@Entity('offers')
@Index(['deliveryId', 'status'])
export class Offer {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Delivery, { onDelete: 'CASCADE' })
  delivery: Delivery;
  @Column('uuid')
  deliveryId: string;

  @ManyToOne(() => User)
  driver: User;
  @Column('uuid')
  driverId: string;

  @ManyToOne(() => Company, { nullable: true })
  company: Company | null;
  @Column({ type: 'uuid', nullable: true })
  companyId: string | null;

  /** Prix proposé (FCFA) */
  @Column('int')
  price: number;

  @Column({ type: 'enum', enum: OfferStatus, default: OfferStatus.PENDING })
  status: OfferStatus;

  /** Contre-proposition du client (entre le prix affiché et la proposition) : le livreur l'accepte ou la refuse */
  @Column({ type: 'int', nullable: true })
  counterPrice: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  counteredAt: Date | null;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
