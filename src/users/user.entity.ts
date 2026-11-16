import { Column, CreateDateColumn, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Company } from '../companies/company.entity';

export enum Role {
  CLIENT = 'CLIENT', // particulier ou boutique qui demande une livraison
  DRIVER = 'DRIVER', // livreur rattaché à une entreprise
  COMPANY = 'COMPANY', // gérant d'une entreprise de livraison
  SUPER_ADMIN = 'SUPER_ADMIN', // super admin (SA) de la plateforme LETO
}

/** Type de compte client, choisi à l'inscription */
export enum AccountType {
  INDIVIDUAL = 'INDIVIDUAL', // particulier
  SHOP = 'SHOP', // boutique / commerce
}

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ unique: true })
  phone: string;

  @Column({ select: false })
  passwordHash: string;

  @Column({ type: 'enum', enum: Role, default: Role.CLIENT })
  role: Role;

  @ManyToOne(() => Company, { nullable: true, onDelete: 'SET NULL' })
  company: Company | null;

  @Column({ type: 'uuid', nullable: true })
  companyId: string | null;

  @Column({ type: 'enum', enum: AccountType, nullable: true })
  accountType: AccountType | null;

  /** Photo de profil (selfie), chemin /uploads/… */
  @Column({ type: 'text', nullable: true })
  avatarUrl: string | null;

  @Column({ default: true })
  active: boolean;

  /** Dernière position GPS connue (livreurs) — mise à jour en temps réel */
  @Column({ type: 'double precision', nullable: true })
  lastLat: number | null;
  @Column({ type: 'double precision', nullable: true })
  lastLng: number | null;
  @Column({ type: 'timestamptz', nullable: true })
  lastLocationAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;
}
