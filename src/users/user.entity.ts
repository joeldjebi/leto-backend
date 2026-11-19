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

  /** Client créé par une entreprise (commande par téléphone) : il active son compte en s'inscrivant */
  @Column({ default: false })
  invited: boolean;

  /** Engin du livreur (MOTO, CAR, CARGO) : icône sur la carte */
  @Column({ type: 'varchar', length: 10, default: 'MOTO' })
  vehicleType: string;

  /** Immatriculation de l'engin (affichée au client pour reconnaître le livreur) */
  @Column({ type: 'varchar', length: 20, nullable: true })
  plate: string | null;

  /** Note moyenne donnée par les clients (1 à 5) et nombre de notes */
  @Column({ type: 'double precision', nullable: true })
  ratingAvg: number | null;
  @Column({ type: 'int', default: 0 })
  ratingCount: number;

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

/** Immatriculation en majuscules, espaces superflus retirés (null si vide) */
export function normalizePlate(v?: string | null): string | null {
  const p = (v ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
  return p ? p.slice(0, 20) : null;
}
