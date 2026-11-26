import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import { Repository } from 'typeorm';
import { AuthUser, CurrentUser, Roles } from '../common/decorators';
import { IsPhone, PHONE_MESSAGE } from '../countries/phone';
import { Role, User } from '../users/user.entity';
import { PartnersService } from './partners.service';

class ConfigDto {
  @IsBoolean() enabled: boolean;
}
class CreateDto {
  @IsString() @IsNotEmpty({ message: 'Nom obligatoire' }) @MaxLength(100) name: string;
  @IsPhone({ message: PHONE_MESSAGE }) phone: string;
  @IsOptional() @IsString() @MaxLength(500) webhookUrl?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
class UpdateDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100) name?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(500) webhookUrl?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(500) note?: string | null;
}
class KeyDto {
  @IsOptional() @IsString() @MaxLength(100) label?: string;
}

/** SA : partenaires de l'API (interrupteur général et par partenaire, clés, webhooks) */
@Controller('partners')
@Roles(Role.SUPER_ADMIN)
export class PartnersController {
  constructor(private service: PartnersService, @InjectRepository(User) private users: Repository<User>) {}

  @Get()
  list() {
    return this.service.list();
  }

  @Put('config')
  async config(@CurrentUser() u: AuthUser, @Body() dto: ConfigDto) {
    return this.service.setEnabled(dto.enabled, (await this.users.findOneBy({ id: u.sub }))?.name ?? 'Super Admin');
  }

  @Post()
  create(@Body() dto: CreateDto) {
    return this.service.create(dto);
  }

  @Get(':id')
  one(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.detail(id);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDto) {
    return this.service.update(id, dto);
  }

  @Post(':id/keys')
  createKey(@Param('id', ParseUUIDPipe) id: string, @Body() dto: KeyDto) {
    return this.service.createKey(id, dto.label ?? 'Clé');
  }

  @Post(':id/keys/:keyId/revoke')
  revoke(@Param('id', ParseUUIDPipe) id: string, @Param('keyId', ParseUUIDPipe) keyId: string) {
    return this.service.revokeKey(id, keyId);
  }

  @Post(':id/secret')
  secret(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.rotateSecret(id);
  }

  @Post(':id/test')
  test(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.test(id);
  }

  @Post(':id/webhooks/:hookId/retry')
  retry(@Param('id', ParseUUIDPipe) id: string, @Param('hookId', ParseUUIDPipe) hookId: string) {
    return this.service.retry(id, hookId);
  }
}
