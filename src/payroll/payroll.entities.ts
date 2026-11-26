import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

export type PayPeriod = 'WEEK' | 'FORTNIGHT' | 'MONTH';

/**
 * Règle de rémunération d'un livreur (entreprise, ou propre au livreur) :
 * fixe par période + montant par colis livré + % du prix des courses, et primes automatiques.
 */
export interface PayRule {
  fixed: number;
  perStop: number;
  percent: number;
  /** Prime si la note moyenne de la période atteint ce seuil (5 notes minimum) */
  ratingBonus?: { min: number; amount: number } | null;
  /** Prime à partir de ce nombre de colis livrés dans la période */
  volumeBonus?: { stops: number; amount: number } | null;
}

export type PayLineKind = 'FIXED' | 'STOPS' | 'PERCENT' | 'BONUS' | 'DEDUCTION' | 'ADVANCE' | 'CASH';
export interface PayLine {
  id: string;
  kind: PayLineKind;
  label: string;
  /** Signé : + gain, − retenue */
  amount: number;
  /** Ligne ajoutée à la main (prime ou retenue), conservée au recalcul */
  manual?: boolean;
  advanceId?: string;
}

export enum PayslipStatus {
  DRAFT = 'DRAFT', // en préparation, recalculable
  PAID = 'PAID', // payée par l'entreprise
  CONFIRMED = 'CONFIRMED', // réception confirmée par le livreur
  DISPUTED = 'DISPUTED', // contestée par le livreur
}

/** Fiche de paie d'un livreur pour une période */
@Entity('payslips')
@Unique(['driverId', 'periodStart'])
export class Payslip {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column('uuid') companyId: string;
  @Index() @Column('uuid') driverId: string;
  @Column({ type: 'varchar', length: 10 }) period: PayPeriod;
  /** AAAA-MM-JJ inclus */
  @Column({ type: 'varchar', length: 10 }) periodStart: string;
  @Column({ type: 'varchar', length: 10 }) periodEnd: string;
  @Column({ type: 'varchar', length: 10, default: PayslipStatus.DRAFT }) status: PayslipStatus;
  @Column({ type: 'int', default: 0 }) deliveries: number;
  @Column({ type: 'int', default: 0 }) stops: number;
  @Column({ type: 'int', default: 0 }) revenue: number;
  @Column({ type: 'jsonb' }) rule: PayRule;
  @Column({ type: 'jsonb', default: () => "'[]'" }) lines: PayLine[];
  /** Gains + primes − retenues − avances (avant compensation des espèces) */
  @Column({ type: 'int', default: 0 }) gross: number;
  /** Espèces encaissées non versées, déduites (compensation automatique) */
  @Column({ type: 'int', default: 0 }) cashCompensated: number;
  /** Payé au livreur */
  @Column({ type: 'int', default: 0 }) net: number;
  @Column({ type: 'timestamptz', nullable: true }) paidAt: Date | null;
  @Column({ type: 'text', nullable: true }) paidBy: string | null;
  @Column({ type: 'varchar', length: 20, nullable: true }) method: 'CASH' | 'MOBILE_MONEY' | null;
  @Column({ type: 'text', nullable: true }) reference: string | null;
  @Column({ type: 'text', nullable: true }) proofUrl: string | null;
  @Column({ type: 'timestamptz', nullable: true }) confirmedAt: Date | null;
  @Column({ type: 'text', nullable: true }) disputeNote: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

export enum AdvanceStatus {
  PENDING = 'PENDING', // demandée par le livreur
  GIVEN = 'GIVEN', // versée par l'entreprise, à retenir sur la prochaine paie
  REJECTED = 'REJECTED',
  DEDUCTED = 'DEDUCTED', // retenue sur une fiche de paie payée
}

/** Avance sur salaire */
@Entity('pay_advances')
export class PayAdvance {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column('uuid') companyId: string;
  @Index() @Column('uuid') driverId: string;
  @Column('int') amount: number;
  @Column({ type: 'text', nullable: true }) reason: string | null;
  @Column({ type: 'varchar', length: 10, default: AdvanceStatus.PENDING }) status: AdvanceStatus;
  @Column({ type: 'varchar', length: 10 }) createdBy: 'DRIVER' | 'COMPANY';
  @Column({ type: 'varchar', length: 20, nullable: true }) method: 'CASH' | 'MOBILE_MONEY' | null;
  @Column({ type: 'text', nullable: true }) reference: string | null;
  @Column({ type: 'text', nullable: true }) decidedBy: string | null;
  @Column({ type: 'timestamptz', nullable: true }) decidedAt: Date | null;
  @Column({ type: 'text', nullable: true }) note: string | null;
  @Column({ type: 'uuid', nullable: true }) payslipId: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}
