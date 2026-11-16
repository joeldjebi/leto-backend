import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, Logger } from '@nestjs/common';
import { mkdirSync } from 'fs';
import { writeFile } from 'fs/promises';
import { join } from 'path';

export const LOCAL_UPLOAD_DIR = 'uploads';

/** Dossiers de stockage */
export type StorageFolder = 'photos' | 'identity';

/**
 * Stockage des fichiers.
 *  - Wasabi (compatible S3) si WAS_ACCESS_KEY / WAS_SECRET_KEY / WASABI_BUCKET sont renseignées.
 *    Les fichiers restent privés : on les sert par des liens signés à durée limitée.
 *    Les pièces d'identité vont dans WASABI_IDENTITY_BUCKET (bucket séparé).
 *  - Sinon, dossier local `uploads/` (développement).
 */
@Injectable()
export class StorageService {
  private logger = new Logger(StorageService.name);
  private s3?: S3Client;

  constructor() {
    const { WAS_ACCESS_KEY, WAS_SECRET_KEY, WASABI_REGION, WASABI_ENDPOINT, WASABI_BUCKET } = process.env;
    if (WAS_ACCESS_KEY && WAS_SECRET_KEY && WASABI_BUCKET) {
      const region = WASABI_REGION || 'eu-central-1';
      this.s3 = new S3Client({
        region,
        endpoint: WASABI_ENDPOINT || `https://s3.${region}.wasabisys.com`,
        credentials: { accessKeyId: WAS_ACCESS_KEY, secretAccessKey: WAS_SECRET_KEY },
        forcePathStyle: true,
      });
      this.logger.log(`Stockage : Wasabi (bucket ${WASABI_BUCKET}, région ${region})`);
    } else {
      mkdirSync(LOCAL_UPLOAD_DIR, { recursive: true });
      this.logger.log('Stockage : dossier local uploads/ (renseignez les variables WASABI_* pour utiliser Wasabi)');
    }
  }

  get usesWasabi() {
    return !!this.s3;
  }

  private bucket(folder: StorageFolder) {
    return folder === 'identity' ? process.env.WASABI_IDENTITY_BUCKET || process.env.WASABI_BUCKET : process.env.WASABI_BUCKET;
  }

  /** Clé de l'objet dans le bucket */
  private key(folder: StorageFolder, name: string) {
    return `${folder}/${name}`;
  }

  async save(name: string, body: Buffer, contentType: string, folder: StorageFolder = 'photos') {
    if (this.s3) {
      await this.s3.send(
        new PutObjectCommand({ Bucket: this.bucket(folder), Key: this.key(folder, name), Body: body, ContentType: contentType }),
      );
    } else {
      await writeFile(join(LOCAL_UPLOAD_DIR, name), body);
    }
  }

  /** Lien de lecture signé (Wasabi), valable [expiresIn] secondes */
  signedUrl(name: string, folder: StorageFolder = 'photos', expiresIn = 3600) {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket(folder), Key: this.key(folder, name) }), { expiresIn });
  }

  localPath(name: string) {
    return join(process.cwd(), LOCAL_UPLOAD_DIR, name);
  }

  async remove(name: string, folder: StorageFolder = 'photos') {
    if (this.s3) await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket(folder), Key: this.key(folder, name) }));
  }
}
