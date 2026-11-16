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
  /**
   * Compte Super Admin piloté par le .env (SUPER_ADMIN_PHONE / SUPER_ADMIN_PASSWORD) :
   * créé au premier démarrage, puis mis à jour à chaque démarrage si le .env a changé.
   */
  async onApplicationBootstrap() {
    const { SUPER_ADMIN_PHONE: phone, SUPER_ADMIN_PASSWORD: password } = process.env;
    if (!phone || !password) return;
    if (password.length < 8) this.logger.warn('SUPER_ADMIN_PASSWORD est court : 8 caractères minimum recommandés');

    const sa = await this.users
      .createQueryBuilder('u')
      .addSelect('u.passwordHash')
      .where('u.role = :role', { role: Role.SUPER_ADMIN })
      .orderBy('u.createdAt', 'ASC')
      .getOne();

    if (!sa) {
      await this.users.save({
        name: 'Super Admin LETO',
        phone,
        passwordHash: await bcrypt.hash(password, 10),
        role: Role.SUPER_ADMIN,
      });
      this.logger.log(`Compte Super Admin créé : ${phone}`);
      return;
    }

    const changes: Partial<User> = {};
    if (sa.phone !== phone) {
      const taken = await this.users.findOneBy({ phone });
      if (taken && taken.id !== sa.id) {
        this.logger.error(`SUPER_ADMIN_PHONE ${phone} est déjà utilisé par un autre compte : numéro non modifié`);
      } else {
        changes.phone = phone;
      }
    }
    if (!(await bcrypt.compare(password, sa.passwordHash))) changes.passwordHash = await bcrypt.hash(password, 10);
    if (!sa.active) changes.active = true;

    if (Object.keys(changes).length) {
      await this.users.update(sa.id, changes);
      const what = [changes.phone && 'numéro', changes.passwordHash && 'mot de passe', changes.active && 'réactivation'].filter(Boolean);
      this.logger.log(`Compte Super Admin mis à jour depuis le .env (${what.join(', ')})`);
    }
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
