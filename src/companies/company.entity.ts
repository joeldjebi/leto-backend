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

  @CreateDateColumn()
  createdAt: Date;
}
