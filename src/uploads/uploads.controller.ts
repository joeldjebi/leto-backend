import { BadRequestException, Controller, Get, NotFoundException, Param, Post, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { randomUUID } from 'crypto';
import type { Response } from 'express';
import { existsSync } from 'fs';
import { memoryStorage } from 'multer';
import { Public } from '../common/decorators';
import { StorageService } from '../storage/storage.service';

const EXT: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic' };
const NAME_REGEX = /^[0-9a-f-]{36}\.(jpg|png|webp|heic|wav)$/;

/**
 * Photos (adresses, preuves d'échec) : envoyées par l'app, stockées sur Wasabi (ou en local en dev).
 * L'app et la base gardent un chemin stable `/uploads/<nom>` ; la lecture redirige vers un lien signé.
 */
@Controller('uploads')
export class UploadsController {
  constructor(private storage: StorageService) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => cb(null, !!EXT[file.mimetype] || file.mimetype === 'image/jpg'),
    }),
  )
  async upload(@UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('Image manquante ou format non accepté (jpg, png, webp, heic, 5 Mo max)');
    const name = `${randomUUID()}${EXT[file.mimetype] ?? '.jpg'}`;
    await this.storage.save(name, file.buffer, file.mimetype === 'image/jpg' ? 'image/jpeg' : file.mimetype);
    return { url: `/uploads/${name}` };
  }

  /** Pièces d'identité (dossier des livreurs indépendants) : stockées à part, jamais publiques */
  @Post('identity')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => cb(null, !!EXT[file.mimetype] || file.mimetype === 'image/jpg'),
    }),
  )
  async uploadIdentity(@UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('Image manquante ou format non accepté (jpg, png, webp, heic, 5 Mo max)');
    const name = `${randomUUID()}${EXT[file.mimetype] ?? '.jpg'}`;
    await this.storage.save(name, file.buffer, file.mimetype === 'image/jpg' ? 'image/jpeg' : file.mimetype, 'identity');
    return { url: `/identity/${name}` };
  }

  /** Lecture publique (noms aléatoires impossibles à deviner) : lien signé Wasabi ou fichier local */
  @Public()
  @Get(':name')
  async read(@Param('name') name: string, @Res() res: Response) {
    if (!NAME_REGEX.test(name)) throw new NotFoundException();
    // Fichier local (développement, ou photo antérieure au passage à Wasabi)
    const path = this.storage.localPath(name);
    if (existsSync(path)) return res.sendFile(path);
    if (!this.storage.usesWasabi) throw new NotFoundException();
    res.setHeader('Cache-Control', 'private, max-age=3000');
    return res.redirect(302, await this.storage.signedUrl(name));
  }
}
