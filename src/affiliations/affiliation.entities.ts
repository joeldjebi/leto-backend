import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type RuleType = 'PERCENT' | 'FIXED';

export enum InviteStatus {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  DECLINED = 'DECLINED',
  CANCELLED = 'CANCELLED', // retirée par l'entreprise, ou devenue sans objet (LI rattaché ailleurs)
}

/**
 * Invitation d'une entreprise à un livreur indépendant (JOIN), ou nouveau taux de commission
 * à faire accepter par un LI déjà rattaché (RATE). Le LI accepte toujours dans l'app.
 */
@Entity('affiliation_invites')
export class AffiliationInvite {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  profileId: string;
  @Index()
  @Column('uuid')
  companyId: string;

  @Column({ type: 'varchar', length: 4, default: 'JOIN' })
  kind: 'JOIN' | 'RATE';

  @Column({ type: 'varchar', length: 7 })
  commissionType: RuleType;
  @Column('double precision')
  commissionValue: number;

  @Column({ type: 'varchar', length: 10, default: InviteStatus.PENDING })
  status: InviteStatus;
  @Column({ type: 'text', nullable: true })
  message: string | null;
  @Column({ type: 'text', nullable: true })
  createdBy: string | null;
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
  @Column({ type: 'timestamptz', nullable: true })
  respondedAt: Date | null;
}

export enum EarningType {
  COMMISSION = 'COMMISSION', // part de l'entreprise sur une course d'un de ses LI
  REVERSAL = 'REVERSAL', // litige donné au client : part reprise
  WITHDRAWAL = 'WITHDRAWAL', // retrait demandé (montant bloqué)
  WITHDRAWAL_CANCELLED = 'WITHDRAWAL_CANCELLED', // retrait refusé : montant rendu
  TRANSFER = 'TRANSFER', // transféré vers le crédit de l'entreprise
}

/**
 * Gains de l'entreprise (commissions prélevées sur le solde de ses LI), gardés par VITE.
 * Disponibles après le délai de sécurité (litiges), puis retirables ou transférables vers le crédit.
 */
@Entity('company_earnings')
export class CompanyEarning {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  companyId: string;

  @Column({ type: 'varchar', length: 22 })
  type: EarningType;
  /** Montant signé (+ gain, − retrait / reprise) */
  @Column('int')
  amount: number;
  /** Disponible (retirable) à partir de cette date */
  @Column({ type: 'timestamptz' })
  availableAt: Date;

  @Column({ type: 'uuid', nullable: true })
  deliveryId: string | null;
  @Column({ type: 'uuid', nullable: true })
  driverId: string | null;
  @Column({ type: 'uuid', nullable: true })
  withdrawalId: string | null;
  @Column({ type: 'text', nullable: true })
  note: string | null;
  @Column({ type: 'text', nullable: true })
  createdBy: string | null;
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

export enum WithdrawalStatus {
  PENDING = 'PENDING', // demandée, à payer par VITE
  PAID = 'PAID', // payée (preuve jointe)
  REJECTED = 'REJECTED', // refusée (motif) : montant rendu
}

/** Demande de retrait des gains (Mobile Money), payée par le SA */
@Entity('company_withdrawals')
export class Withdrawal {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  companyId: string;
  @Column('int')
  amount: number;
  @Column({ type: 'varchar', length: 40 })
  operator: string;
  @Column({ type: 'varchar', length: 20 })
  phone: string;
  @Column({ type: 'varchar', length: 10, default: WithdrawalStatus.PENDING })
  status: WithdrawalStatus;
  @Column({ type: 'text', nullable: true })
  note: string | null;
  @Column({ type: 'text', nullable: true })
  proofUrl: string | null;
  @Column({ type: 'text', nullable: true })
  reference: string | null;
  @Column({ type: 'text', nullable: true })
  requestedBy: string | null;
  @Column({ type: 'text', nullable: true })
  processedBy: string | null;
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
  @Column({ type: 'timestamptz', nullable: true })
  processedAt: Date | null;
}
