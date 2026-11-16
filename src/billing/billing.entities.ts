import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Company } from '../companies/company.entity';

export enum PaymentKind {
  SUBSCRIPTION = 'SUBSCRIPTION', // abonnement annuel
  TOPUP = 'TOPUP', // recharge de crédit
}

export enum PaymentStatus {
  PENDING = 'PENDING', // preuve envoyée, à vérifier par le SA
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

/** Paiement Mobile Money déclaré par une entreprise (avec preuve), validé par le SA */
@Entity('payments')
export class Payment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE' })
  company: Company;
  @Index()
  @Column('uuid')
  companyId: string;

  @Column({ type: 'enum', enum: PaymentKind })
  kind: PaymentKind;

  @Column('int')
  amount: number;

  /** Opérateur (Wave, Orange Money, MTN MoMo, Moov Money) */
  @Column()
  operator: string;
  @Column()
  senderPhone: string;
  @Column({ type: 'text', nullable: true })
  reference: string | null;
  @Column()
  proofUrl: string;

  @Column({ type: 'enum', enum: PaymentStatus, default: PaymentStatus.PENDING })
  status: PaymentStatus;

  @Column({ type: 'text', nullable: true })
  submittedBy: string | null;
  @Column({ type: 'text', nullable: true })
  reviewNote: string | null;
  @Column({ type: 'text', nullable: true })
  reviewedBy: string | null;
  @Column({ type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

export enum CreditType {
  TOPUP = 'TOPUP', // recharge validée
  COMMISSION = 'COMMISSION', // commission d'une course
  REFUND = 'REFUND', // remboursement (litige donné au client)
  ADJUSTMENT = 'ADJUSTMENT', // correction manuelle du SA
}

/** Journal du crédit : chaque mouvement est enregistré, jamais modifié */
@Entity('credit_transactions')
export class CreditTransaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  companyId: string;

  @Column({ type: 'enum', enum: CreditType })
  type: CreditType;

  /** Montant signé (+ crédit, − débit) */
  @Column('int')
  amount: number;
  @Column('int')
  balanceAfter: number;

  @Column({ type: 'uuid', nullable: true })
  deliveryId: string | null;
  @Column({ type: 'uuid', nullable: true })
  paymentId: string | null;
  @Column({ type: 'text', nullable: true })
  note: string | null;
  @Column({ type: 'text', nullable: true })
  createdBy: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
