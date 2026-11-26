import { Column, CreateDateColumn, Entity, Index, JoinColumn, OneToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { User } from '../users/user.entity';

export enum IndependentStatus {
  DRAFT = 'DRAFT', // compte créé, dossier pas encore envoyé
  PENDING = 'PENDING', // dossier envoyé, à vérifier par LETO
  APPROVED = 'APPROVED', // validé : peut prendre des courses
  REJECTED = 'REJECTED', // refusé (motif) : le livreur corrige et renvoie
  SUSPENDED = 'SUSPENDED', // suspendu par LETO
}

export interface IndependentEvent {
  at: string;
  action: 'CREATED' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'SUSPENDED' | 'REACTIVATED';
  by?: string;
  note?: string;
}

/** Photos du dossier : le selfie (/uploads/…, photo de profil) et les documents (/identity/…, stockés à part, jamais publics) */
export const DOC_FIELDS = ['selfieUrl', 'docsSelfieUrl', 'idFrontUrl', 'idBackUrl', 'licenseUrl', 'registrationUrl', 'insuranceUrl'] as const;
export type DocField = (typeof DOC_FIELDS)[number];

/**
 * Dossier d'un livreur indépendant (LI) : identité, engin et photos prises à l'appareil photo.
 * Le LI a sa propre « entreprise » individuelle (crédit prépayé, commission LI).
 */
@Entity('independent_profiles')
export class IndependentProfile {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn()
  user: User;
  @Index({ unique: true })
  @Column('uuid')
  userId: string;

  @Index({ unique: true })
  @Column('uuid')
  companyId: string;

  @Column({ type: 'varchar', length: 12, default: IndependentStatus.DRAFT })
  status: IndependentStatus;

  // ----- Identité -----
  @Column({ type: 'varchar', length: 10, nullable: true }) birthDate: string | null; // AAAA-MM-JJ
  @Column({ type: 'varchar', length: 40, nullable: true }) commune: string | null;
  @Column({ type: 'varchar', length: 150, nullable: true }) address: string | null; // quartier, repère
  @Column({ type: 'varchar', length: 12, nullable: true }) idType: string | null; // CNI, PASSPORT, CONSULAR
  @Column({ type: 'varchar', length: 40, nullable: true }) idNumber: string | null;
  @Column({ type: 'varchar', length: 100, nullable: true }) emergencyName: string | null;
  @Column({ type: 'varchar', length: 20, nullable: true }) emergencyPhone: string | null;

  // ----- Engin -----
  @Column({ type: 'varchar', length: 10, nullable: true }) vehicleType: string | null;
  @Column({ type: 'varchar', length: 60, nullable: true }) vehicleBrand: string | null;
  @Column({ type: 'varchar', length: 20, nullable: true }) vehiclePlate: string | null;
  @Column({ type: 'varchar', length: 40, nullable: true }) licenseNumber: string | null;

  // ----- Photos (appareil photo uniquement) -----
  @Column({ type: 'text', nullable: true }) selfieUrl: string | null;
  @Column({ type: 'text', nullable: true }) docsSelfieUrl: string | null; // le livreur, avec ses documents en main
  @Column({ type: 'text', nullable: true }) idFrontUrl: string | null;
  @Column({ type: 'text', nullable: true }) idBackUrl: string | null;
  @Column({ type: 'text', nullable: true }) licenseUrl: string | null;
  @Column({ type: 'text', nullable: true }) registrationUrl: string | null; // carte grise
  @Column({ type: 'text', nullable: true }) insuranceUrl: string | null;

  /** Accord du livreur pour le traitement de ses données */
  @Column({ type: 'timestamptz', nullable: true }) consentAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) submittedAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) reviewedAt: Date | null;
  @Column({ type: 'text', nullable: true }) reviewedBy: string | null;
  /** Motif du refus ou de la suspension */
  @Column({ type: 'text', nullable: true }) reviewNote: string | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  history: IndependentEvent[];

  // ----- Rattachement à une entreprise de livraison (responsable du LI) -----
  @Index()
  @Column({ type: 'uuid', nullable: true }) affiliatedCompanyId: string | null;
  @Column({ type: 'timestamptz', nullable: true }) affiliatedAt: Date | null;
  /** Commission de l'entreprise acceptée par le LI (plafonnée par LETO au moment du calcul) */
  @Column({ type: 'varchar', length: 7, nullable: true }) affCommissionType: 'PERCENT' | 'FIXED' | null;
  @Column({ type: 'double precision', nullable: true }) affCommissionValue: number | null;
  /** LI validé avant le rattachement obligatoire : peut travailler seul jusqu'à cette date */
  @Column({ type: 'timestamptz', nullable: true }) legacyUntil: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
