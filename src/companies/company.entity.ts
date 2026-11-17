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

  /** « Entreprise » individuelle d'un livreur indépendant (LI) : pas d'abonnement, commission LI */
  @Column({ default: false })
  independent: boolean;

  @CreateDateColumn()
  createdAt: Date;
}
