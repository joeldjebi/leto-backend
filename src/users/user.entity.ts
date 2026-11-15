import { Column, CreateDateColumn, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Company } from '../companies/company.entity';

export enum Role {
  CLIENT = 'CLIENT', // particulier ou boutique qui demande une livraison
  DRIVER = 'DRIVER', // livreur rattaché à une entreprise
  COMPANY = 'COMPANY', // gérant d'une entreprise de livraison
  ADMIN = 'ADMIN', // administrateur de la plateforme
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

  @Column({ default: true })
  active: boolean;

  @CreateDateColumn()
  createdAt: Date;
}
