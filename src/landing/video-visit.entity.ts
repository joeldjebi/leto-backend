import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Visite de la page de présentation vidéo (vite.ci/video) : quand, où, sur quel appareil, combien de temps */
@Entity('video_visits')
export class VideoVisit {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  /** Dernier signe de vie (progression de la lecture) */
  @Column({ type: 'timestamptz', nullable: true })
  lastSeenAt: Date | null;

  /** Pays (code ISO) et ville approximatifs, déduits de l'adresse IP (qui n'est pas conservée) */
  @Column({ type: 'varchar', length: 2, nullable: true })
  country: string | null;
  @Column({ type: 'varchar', length: 80, nullable: true })
  city: string | null;

  /** Téléphone, Tablette ou Ordinateur ; système (Android, iPhone…) ; provenance (WhatsApp, Facebook…) */
  @Column({ type: 'varchar', length: 20 })
  device: string;
  @Column({ type: 'varchar', length: 30, nullable: true })
  os: string | null;
  @Column({ type: 'varchar', length: 40, nullable: true })
  source: string | null;

  /** Vidéo affichée (horizontale ou verticale) */
  @Column({ type: 'varchar', length: 12, default: 'horizontal' })
  video: string;

  /** Durée regardée et durée de la vidéo (secondes) */
  @Column({ type: 'int', default: 0 })
  watchedSec: number;
  @Column({ type: 'int', nullable: true })
  durationSec: number | null;

  /** Empreinte anonyme du visiteur (IP + navigateur hachés) : distingue une première visite d'un retour */
  @Index()
  @Column({ type: 'varchar', length: 64 })
  visitor: string;

  /** Jeton remis au navigateur : lui seul peut mettre à jour la durée regardée de sa visite */
  @Column({ type: 'varchar', length: 32, select: false })
  token: string;
}
