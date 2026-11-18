import { Body, Controller, Get, Post, Put, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { InjectRepository } from '@nestjs/typeorm';
import { memoryStorage } from 'multer';
import { Repository } from 'typeorm';
import { AuthUser, CurrentUser, Public, Roles } from '../common/decorators';
import { Role, User } from '../users/user.entity';
import { LandingContent, LandingService } from './landing.service';

/** Contenu de la landing page : lecture publique, modification par l'admin */
@Controller()
export class LandingController {
  constructor(
    private landing: LandingService,
    @InjectRepository(User) private users: Repository<User>,
  ) {}

  private async by(user: AuthUser) {
    return (await this.users.findOneBy({ id: user.sub }))?.name ?? 'LETO';
  }

  @Public()
  @Get('landing')
  get() {
    return this.landing.get();
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
