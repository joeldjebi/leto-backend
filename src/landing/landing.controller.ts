import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import type { Request } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { InjectRepository } from '@nestjs/typeorm';
import { memoryStorage } from 'multer';
import { Repository } from 'typeorm';
import { AuthUser, CurrentUser, Public, Roles } from '../common/decorators';
import { Role, User } from '../users/user.entity';
import { LandingContent, LandingService } from './landing.service';
import { VideoVisitsService } from './video-visits.service';

/** Contenu de la landing page : lecture publique, modification par l'admin */
@Controller()
export class LandingController {
  constructor(
    private landing: LandingService,
    private visits: VideoVisitsService,
    @InjectRepository(User) private users: Repository<User>,
  ) {}

  private async by(user: AuthUser) {
    return (await this.users.findOneBy({ id: user.sub }))?.name ?? 'VITE';
  }

  @Public()
  @Get('landing')
  get() {
    return this.landing.get();
  }

  // ----- Visites de la page vidéo (leto.performx.online/video) -----

  /** Ouverture de la page vidéo : enregistrée (pays, appareil, provenance), l'IP n'est pas conservée */
  @Public()
  @Post('landing/video-visit')
  videoVisit(@Req() req: Request, @Body() body: { video?: string; referrer?: string }) {
    const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    const ip = (fwd || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    return this.visits.start(ip, String(req.headers['user-agent'] ?? ''), body ?? {});
  }

  /** Durée regardée (mise à jour pendant la lecture et à la fermeture de la page) */
  @Public()
  @Post('landing/video-visit/:id')
  videoProgress(@Param('id', ParseUUIDPipe) id: string, @Body() body: { token?: string; watched?: string; duration?: string }) {
    return this.visits.progress(id, body ?? {});
  }

  @Get('admin/video-visits')
  @Roles(Role.SUPER_ADMIN)
  videoVisits() {
    return this.visits.list();
  }

  @Get('admin/landing')
  @Roles(Role.SUPER_ADMIN)
  admin() {
    return { content: this.landing.get(), defaults: this.landing.defaults };
  }

  @Put('admin/landing')
  @Roles(Role.SUPER_ADMIN)
  async update(@CurrentUser() user: AuthUser, @Body() body: Partial<LandingContent>) {
    return this.landing.update(body ?? {}, await this.by(user));
  }

  @Post('admin/landing/reset')
  @Roles(Role.SUPER_ADMIN)
  async reset(@CurrentUser() user: AuthUser) {
    return this.landing.reset(await this.by(user));
  }

  @Post('admin/landing/apk')
  @Roles(Role.SUPER_ADMIN)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } }))
  async apk(@CurrentUser() user: AuthUser, @Body('version') version: string, @UploadedFile() file?: Express.Multer.File) {
    return this.landing.uploadApk(file, version ?? '', await this.by(user));
  }
}
