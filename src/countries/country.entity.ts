import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/** Pays géré par l'admin : indicatif, format du numéro, devise */
@Entity('countries')
export class Country {
  @PrimaryGeneratedColumn('uuid') id: string;
  /** Code ISO 3166-1 alpha-2 (CI) ; le drapeau en est déduit */
  @Column({ type: 'varchar', length: 2, unique: true }) iso: string;
  @Column({ type: 'varchar', length: 60 }) name: string;
  /** Indicatif sans « + » (225) */
  @Column({ type: 'varchar', length: 4 }) dialCode: string;
  /** Nombre de chiffres après l'indicatif */
  @Column({ type: 'int' }) phoneLength: number;
  /** Préfixe national retiré à l'international (« 0 » au Ghana, en France…) */
  @Column({ type: 'varchar', length: 2, default: '' }) trunkPrefix: string;
  /** Exemple affiché dans les champs (format local) */
  @Column({ type: 'varchar', length: 20, default: '' }) phoneExample: string;
  @Column({ type: 'varchar', length: 3 }) currencyCode: string;
  @Column({ type: 'varchar', length: 8 }) currencySymbol: string;
  @Column({ type: 'varchar', length: 40, default: '' }) currencyName: string;
  @Column({ type: 'int', default: 0 }) currencyDecimals: number;
  /** Proposé dans les sélecteurs d'indicatif */
  @Column({ default: false }) active: boolean;
  /** Pays où LETO livre (tarifs, commissions et montants dans sa devise) ; un seul */
  @Column({ default: false }) operating: boolean;
  @Column({ type: 'int', default: 100 }) sortOrder: number;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}
