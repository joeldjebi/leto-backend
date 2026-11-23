import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/** Étapes de la prospection, dans l'ordre */
export const PROSPECT_STATUSES = ['TODO', 'CONTACTED', 'FOLLOW_UP', 'MEETING', 'DEMO', 'WON', 'LOST'] as const;
export type ProspectStatus = (typeof PROSPECT_STATUSES)[number];

/** Une ligne de l'historique d'un prospect (prise de contact, note, changement d'étape) */
export interface ProspectEvent {
  at: string;
  kind: 'NOTE' | 'CONTACT' | 'STATUS';
  text: string;
  by: string;
}

/** Entreprise de livraison à démarcher (espace Prospection du Super Admin) */
@Entity('prospects')
export class Prospect {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 120 })
  name: string;
  /** Pays (ISO2) ou MULTI ; ville(s) */
  @Column({ type: 'varchar', length: 8, default: 'CI' })
  country: string;
  @Column({ type: 'varchar', length: 120, nullable: true })
  city: string | null;

  /** 1 = prioritaire, 2 = à tenter, 3 = plus difficile (a déjà son outil) */
  @Column({ type: 'smallint', default: 2 })
  priority: number;
  /** Ce que fait l'entreprise, en une ligne */
  @Column({ type: 'varchar', length: 300, nullable: true })
  description: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  website: string | null;
  @Column({ type: 'varchar', length: 30, nullable: true })
  phone: string | null;
  @Column({ type: 'varchar', length: 30, nullable: true })
  whatsapp: string | null;
  @Column({ type: 'varchar', length: 160, nullable: true })
  email: string | null;
  @Column({ type: 'varchar', length: 300, nullable: true })
  facebook: string | null;
  @Column({ type: 'varchar', length: 300, nullable: true })
  instagram: string | null;
  @Column({ type: 'varchar', length: 300, nullable: true })
  linkedin: string | null;
  /** Personne à contacter (nom, rôle) */
  @Column({ type: 'varchar', length: 160, nullable: true })
  contactName: string | null;

  @Column({ type: 'varchar', length: 12, default: 'TODO' })
  status: ProspectStatus;
  /** Dernière prise de contact et prochaine action prévue (relance, rendez-vous) */
  @Column({ type: 'timestamptz', nullable: true })
  lastContactAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true })
  nextActionAt: Date | null;
  @Column({ type: 'varchar', length: 200, nullable: true })
  nextAction: string | null;

  @Column({ type: 'text', nullable: true })
  notes: string | null;
  /** Messages de premier contact (« {prenom} » remplacé par l'expéditeur) */
  @Column({ type: 'text', nullable: true })
  waMessage: string | null;
  @Column({ type: 'varchar', length: 200, nullable: true })
  emailSubject: string | null;
  @Column({ type: 'text', nullable: true })
  emailBody: string | null;
  @Column({ type: 'jsonb', default: () => "'[]'" })
  history: ProspectEvent[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
