import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { User } from '../users/user.entity';

export enum RemittanceStatus {
  PENDING = 'PENDING', // déclaré par le livreur, à confirmer par l'entreprise
  CONFIRMED = 'CONFIRMED',
  REJECTED = 'REJECTED',
}

/** Versement d'un livreur à son entreprise (espèces encaissées pendant les courses) */
@Entity('driver_remittances')
export class Remittance {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  companyId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  driver: User;
  @Index()
  @Column('uuid')
  driverId: string;

  @Column('int')
  amount: number;

  /** CASH (remis en main propre), MOBILE_MONEY, ou PAYROLL (déduit de la paie : compensation automatique) */
  @Column({ type: 'varchar', length: 20 })
  method: 'CASH' | 'MOBILE_MONEY' | 'PAYROLL';
  @Column({ type: 'text', nullable: true })
  reference: string | null;
  @Column({ type: 'text', nullable: true })
  proofUrl: string | null;
  @Column({ type: 'text', nullable: true })
  note: string | null;

  @Column({ type: 'enum', enum: RemittanceStatus, default: RemittanceStatus.PENDING })
  status: RemittanceStatus;

  /** Déclaré par le livreur ou enregistré directement par l'entreprise */
  @Column({ type: 'varchar', length: 10 })
  createdBy: 'DRIVER' | 'COMPANY';
  @Column({ type: 'text', nullable: true })
  reviewedBy: string | null;
  @Column({ type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;
  @Column({ type: 'text', nullable: true })
  reviewNote: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
