import { Controller, Get, Param, ParseBoolPipe, ParseUUIDPipe, Patch, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { Roles } from '../common/decorators';
import { Role, User } from './user.entity';

/** Gestion des utilisateurs par le Super Admin (SA) */
@Controller('users')
@Roles(Role.SUPER_ADMIN)
export class UsersController {
  constructor(@InjectRepository(User) private users: Repository<User>) {}

  @Get()
  findAll(@Query('role') role?: Role) {
    return this.users.find({
      where: role ? { role } : { role: Not(Role.SUPER_ADMIN) },
      relations: { company: true },
      order: { createdAt: 'DESC' },
    });
  }

  @Patch(':id/active')
  async setActive(@Param('id', ParseUUIDPipe) id: string, @Query('value', ParseBoolPipe) value: boolean) {
    await this.users.update({ id, role: Not(Role.SUPER_ADMIN) }, { active: value });
    return this.users.findOneBy({ id });
  }
}
