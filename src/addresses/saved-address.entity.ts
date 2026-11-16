import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { User } from '../users/user.entity';

/** Carnet d'adresses : destinataires fréquents d'un client / d'une boutique */
@Entity('saved_addresses')
@Index(['clientId', 'recipientPhone'], { unique: true })
export class SavedAddress {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  client: User;
  @Column('uuid')
  clientId: string;

  @Column()
  recipientName: string;
  @Column()
  recipientPhone: string;

  @Column()
  address: string;
  @Column({ type: 'text', nullable: true })
  details: string | null;
  @Column({ type: 'double precision' })
  lat: number;
  @Column({ type: 'double precision' })
  lng: number;

  @Column({ type: 'int', default: 0 })
  usedCount: number;
  @Column({ type: 'timestamptz', nullable: true })
  lastUsedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
