import {
  ConflictException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { Repository } from 'typeorm';
import { PersonDto } from '../common/dto';
import { Role, User } from '../users/user.entity';
import { LoginDto } from './auth.dto';

@Injectable()
export class AuthService implements OnApplicationBootstrap {
  private logger = new Logger(AuthService.name);

  constructor(@InjectRepository(User) private users: Repository<User>, private jwt: JwtService) {}

  /** Crée le compte super-admin au premier démarrage */
  async onApplicationBootstrap() {
    const { SUPER_ADMIN_PHONE, SUPER_ADMIN_PASSWORD } = process.env;
    if (!SUPER_ADMIN_PHONE || !SUPER_ADMIN_PASSWORD) return;
    if (await this.users.existsBy({ role: Role.SUPER_ADMIN })) return;
    await this.users.save({
      name: 'Super Admin LETO',
      phone: SUPER_ADMIN_PHONE,
      passwordHash: await bcrypt.hash(SUPER_ADMIN_PASSWORD, 10),
      role: Role.SUPER_ADMIN,
    });
    this.logger.log(`Compte super admin créé : ${SUPER_ADMIN_PHONE}`);
  }

  /** Inscription publique : uniquement des clients (particuliers / boutiques) */
  async register(dto: PersonDto) {
    if (await this.users.existsBy({ phone: dto.phone })) {
      throw new ConflictException('Ce numéro est déjà utilisé');
    }
    const user = await this.users.save({
      name: dto.name,
      phone: dto.phone,
      passwordHash: await bcrypt.hash(dto.password, 10),
      role: Role.CLIENT,
    });
    return this.session(user);
  }

  async login(dto: LoginDto) {
    const user = await this.users
      .createQueryBuilder('u')
      .addSelect('u.passwordHash')
      .leftJoinAndSelect('u.company', 'company')
      .where('u.phone = :phone', { phone: dto.phone })
      .getOne();
    if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('Numéro ou mot de passe incorrect');
    }
    if (!user.active || (user.company && !user.company.active)) {
      throw new UnauthorizedException('Compte désactivé');
    }
    return this.session(user);
  }

  me(id: string) {
    return this.users.findOne({ where: { id }, relations: { company: true } });
  }

  private async session(user: User) {
    const token = await this.jwt.signAsync({
      sub: user.id,
      role: user.role,
      companyId: user.companyId,
    });
    delete user.passwordHash;
    return { token, user };
  }
}
