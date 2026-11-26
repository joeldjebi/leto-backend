import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Partenaire de l'API LETO (Adjamé-Smart, boutiques en ligne…) : crée des courses par l'API
 * avec ses clés, reçoit les changements de statut par webhook. Ses courses sont passées
 * au nom de son compte client LETO (userId).
 */
@Entity('partners')
export class Partner {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar', length: 100 }) name: string;
  @Index() @Column('uuid') userId: string;
  /** Interrupteur du SA pour ce partenaire */
  @Column({ default: true }) active: boolean;
  @Column({ type: 'text', nullable: true }) webhookUrl: string | null;
  /** Secret de signature des webhooks (HMAC SHA-256) */
  @Column({ type: 'varchar', length: 80 }) webhookSecret: string;
  @Column({ type: 'text', nullable: true }) note: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}

/** Clé d'API d'un partenaire : seule son empreinte est gardée, la clé n'est montrée qu'une fois */
@Entity('partner_keys')
export class PartnerKey {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column('uuid') partnerId: string;
  @Column({ type: 'varchar', length: 100 }) label: string;
  /** Début de la clé, affiché pour la reconnaître (« leto_live_ab12… ») */
  @Column({ type: 'varchar', length: 24 }) prefix: string;
  @Index({ unique: true }) @Column({ type: 'varchar', length: 64 }) hash: string;
  @Column({ type: 'timestamptz', nullable: true }) lastUsedAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) revokedAt: Date | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}

export type WebhookStatus = 'PENDING' | 'SENT' | 'FAILED';

/** Envoi d'un webhook (avec relances) */
@Entity('partner_webhooks')
export class PartnerWebhook {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column('uuid') partnerId: string;
  @Column({ type: 'uuid', nullable: true }) deliveryId: string | null;
  @Column({ type: 'varchar', length: 40 }) event: string;
  @Column({ type: 'jsonb' }) payload: Record<string, unknown>;
  @Index() @Column({ type: 'varchar', length: 10, default: 'PENDING' }) status: WebhookStatus;
  @Column({ type: 'int', default: 0 }) attempts: number;
  @Index() @Column({ type: 'timestamptz' }) nextAttemptAt: Date;
  @Column({ type: 'int', nullable: true }) responseCode: number | null;
  @Column({ type: 'text', nullable: true }) lastError: string | null;
  @Column({ type: 'timestamptz', nullable: true }) sentAt: Date | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}
