import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** Réglages de la plateforme (clé → valeur JSON) */
@Entity('settings')
export class Setting {
  @PrimaryColumn()
  key: string;

  @Column('jsonb')
  value: unknown;

  @Column({ type: 'text', nullable: true })
  updatedBy: string | null;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
