import { Body, Controller, Delete, Get, Param, Post, Put, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { InjectRepository } from '@nestjs/typeorm';
import { memoryStorage } from 'multer';
import { Repository } from 'typeorm';
import { AuthUser, CurrentUser, Roles } from '../common/decorators';
import { Role, User } from '../users/user.entity';
import { NotifyService } from './notify.service';

/** Sons des notifications : 3 sons LETO intégrés, sons ajoutés par l'admin, un son par événement */
@Controller('notifications')
export class NotificationsController {
  constructor(
    private notify: NotifyService,
    @InjectRepository(User) private users: Repository<User>,
  ) {}

  private async by(user: AuthUser) {
    return (await this.users.findOneBy({ id: user.sub }))?.name ?? 'LETO';
  }

  /** L'app télécharge la liste au démarrage (et quand l'admin la change) */
  @Get('sounds')
  sounds() {
    return this.notify.sounds;
  }

  @Put('sounds/events')
  @Roles(Role.SUPER_ADMIN)
  async setEvents(@CurrentUser() user: AuthUser, @Body() body: Record<string, string>) {
    return this.notify.setEvents(body ?? {}, await this.by(user));
  }

  @Post('sounds')
  @Roles(Role.SUPER_ADMIN)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } }))
  async add(@CurrentUser() user: AuthUser, @Body('name') name: string, @UploadedFile() file?: Express.Multer.File) {
    return this.notify.addSound(name ?? '', file, await this.by(user));
  }

  @Delete('sounds/:id')
  @Roles(Role.SUPER_ADMIN)
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.notify.removeSound(id, await this.by(user));
  }
}
