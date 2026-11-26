import { OpeningHours } from './opening';
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('companies')
export class Company {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column()
  phone: string;

  @Column({ default: true })
  active: boolean;

  /** Crédit prépayé (FCFA) : la commission LETO de chaque course y est prélevée */
  @Column({ type: 'int', default: 0 })
  credit: number;

  /** Fin de l'abonnement annuel (null = jamais payé) */
  @Column({ type: 'timestamptz', nullable: true })
  subscriptionEndsAt: Date | null;

  /** Fin de l'essai gratuit : jusque-là ni abonnement ni crédit nécessaires, aucune commission prélevée */
  @Column({ type: 'timestamptz', nullable: true })
  trialEndsAt: Date | null;

  /** Commission propre à l'entreprise (sinon : règle par défaut du SA) */
  @Column({ type: 'varchar', length: 10, nullable: true })
  commissionType: 'PERCENT' | 'FIXED' | null;
  @Column({ type: 'double precision', nullable: true })
  commissionValue: number | null;

  /** Part du prix de chaque course gardée par le livreur (%) ; 0 = il verse tout (salarié) */
  @Column({ type: 'double precision', default: 0 })
  driverSharePercent: number;

  /** Grille tarifaire propre à l'entreprise (prix seulement ; null = grille LETO) */
  @Column({ type: 'jsonb', nullable: true })
  pricing: Record<string, unknown> | null;

  /** Engins dont l'entreprise dispose (MOTO, CAR, CARGO) ; null = tous */
  @Column({ type: 'jsonb', nullable: true })
  vehicles: string[] | null;

  /** Inscription en ligne : PENDING (à valider par LETO), APPROVED, REJECTED. Créées par l'admin : APPROVED */
  @Column({ type: 'varchar', length: 10, default: 'APPROVED' })
  status: 'PENDING' | 'APPROVED' | 'REJECTED';

  /** Demande d'inscription : commune, taille de flotte, message ; décision de LETO */
  @Column({ type: 'jsonb', nullable: true })
  application: { commune?: string; drivers?: number; vehicles?: string[]; message?: string; managerName?: string; managerPhone?: string; appliedAt?: string } | null;
  @Column({ type: 'text', nullable: true })
  reviewNote: string | null;
  @Column({ type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;

  /** « Entreprise » individuelle d'un livreur indépendant (LI) : pas d'abonnement, commission LI */
  @Column({ default: false })
  independent: boolean;

  /** Commission prélevée sur les courses de ses livreurs indépendants rattachés (null = pas encore définie) */
  @Column({ type: 'varchar', length: 7, nullable: true })
  liCommissionType: 'PERCENT' | 'FIXED' | null;
  @Column({ type: 'double precision', nullable: true })
  liCommissionValue: number | null;

  /** Ses livreurs indépendants peuvent prendre les courses avec paiement à la livraison (encaissements versés à l'entreprise) */
  @Column({ default: false })
  liCodAllowed: boolean;

  /** Ouverte aux commandes des clients (interrupteur du gérant) */
  @Column({ default: true })
  acceptingOrders: boolean;

  /** Horaires d'ouverture automatiques (null = selon l'interrupteur seulement) */
  @Column({ type: 'jsonb', nullable: true })
  openingHours: OpeningHours | null;

  /** SA : ses livreurs voient les commandes ouvertes (sinon seulement celles à son nom et ses affectations) */
  @Column({ default: true })
  openOrders: boolean;

  /** SA : ses livreurs indépendants voient les commandes ouvertes */
  @Column({ default: true })
  liOpenOrders: boolean;

  /** Dernière visite du vivier des livreurs indépendants (bandeau « nouveaux livreurs ») */
  @Column({ type: 'timestamptz', nullable: true })
  liPoolSeenAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;
}
