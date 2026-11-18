import { IsPhone, PHONE_MESSAGE } from '../countries/phone';
import { Body, Controller, Delete, Get, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsLatitude, IsLongitude, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { Brackets, Repository } from 'typeorm';
import { AuthUser, CurrentUser, Roles } from '../common/decorators';
import { Role } from '../users/user.entity';
import { SavedAddress } from './saved-address.entity';

class SaveAddressDto {
  @IsString() @IsNotEmpty() @MaxLength(100) recipientName: string;
  @IsPhone({ message: PHONE_MESSAGE }) recipientPhone: string;
  @IsString() @IsNotEmpty() @MaxLength(200) address: string;
  @IsOptional() @IsString() @MaxLength(500) details?: string;
  @IsLatitude() lat: number;
  @IsLongitude() lng: number;
}

/** Carnet d'adresses du client (alimenté automatiquement à chaque commande) */
@Controller('addresses')
@Roles(Role.CLIENT)
export class AddressesController {
  constructor(@InjectRepository(SavedAddress) private repo: Repository<SavedAddress>) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('q') q?: string) {
    const qb = this.repo
      .createQueryBuilder('a')
      .where('a.clientId = :id', { id: user.sub })
      .orderBy('a.lastUsedAt', 'DESC', 'NULLS LAST')
      .limit(200);
    if (q?.trim()) {
      qb.andWhere(
        new Brackets((w) =>
          w
            .where('a.recipientName ILIKE :q', { q: `%${q.trim()}%` })
            .orWhere('a.recipientPhone LIKE :q')
            .orWhere('a.address ILIKE :q'),
        ),
      );
    }
    return qb.getMany();
  }

  /** Ajout ou mise à jour (par numéro de téléphone) */
  @Post()
  async save(@CurrentUser() user: AuthUser, @Body() dto: SaveAddressDto) {
    const existing = await this.repo.findOneBy({ clientId: user.sub, recipientPhone: dto.recipientPhone });
    return this.repo.save({ ...(existing ?? {}), ...dto, clientId: user.sub });
  }

  @Delete(':id')
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const res = await this.repo.delete({ id, clientId: user.sub });
    if (!res.affected) throw new NotFoundException('Adresse introuvable');
    return { ok: true };
  }
}
