import {
  BadRequestException,
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
import { Role, User } from '../users/user.entity';
import { LoginDto, RegisterDto, UpdateProfileDto } from './auth.dto';

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
  async register(dto: RegisterDto) {
    const existing = await this.users.findOneBy({ phone: dto.phone });
    // Compte créé par une entreprise (commande par téléphone) : le client l'active en s'inscrivant
    if (existing?.invited && existing.role === Role.CLIENT) {
      await this.users.update(existing.id, {
        name: dto.name,
        passwordHash: await bcrypt.hash(dto.password, 10),
        accountType: dto.accountType,
        invited: false,
      });
      return this.session(await this.users.findOneBy({ id: existing.id }));
    }
    if (existing) {
      throw new ConflictException('Ce numéro est déjà utilisé');
    }
    const user = await this.users.save({
      name: dto.name,
      phone: dto.phone,
      passwordHash: await bcrypt.hash(dto.password, 10),
      role: Role.CLIENT,
      accountType: dto.accountType,
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
    if (user.company?.status === 'PENDING') {
      throw new UnauthorizedException('Votre demande d’inscription est en cours de validation par LETO. Vous serez contacté dès qu’elle est acceptée.');
    }
    if (user.company?.status === 'REJECTED') {
      throw new UnauthorizedException(`Votre demande d’inscription n’a pas été acceptée${user.company.reviewNote ? ` : ${user.company.reviewNote}` : ''}. Contactez LETO.`);
    }
    if (!user.active || (user.company && !user.company.active)) {
      throw new UnauthorizedException('Compte désactivé');
    }
    return this.session(user);
  }

  me(id: string) {
    return this.users.findOne({ where: { id }, relations: { company: true } });
  }

  /** Profil : nom, type de compte (clients), numéro et mot de passe (avec le mot de passe actuel) */
  async updateProfile(id: string, dto: UpdateProfileDto) {
    const user = await this.users.createQueryBuilder('u').addSelect('u.passwordHash').where('u.id = :id', { id }).getOne();
    if (!user) throw new UnauthorizedException();
    const changes: Partial<User> = {};
    if (dto.name !== undefined) changes.name = dto.name.trim();
    if (dto.accountType !== undefined && user.role === Role.CLIENT) changes.accountType = dto.accountType;
    if (dto.avatarUrl !== undefined) {
      // Livreur indépendant : sa photo de profil est le selfie de son dossier
      const independent = user.companyId && (await this.users.manager.query(`SELECT 1 FROM companies WHERE id = $1 AND independent`, [user.companyId])).length;
      if (independent) throw new BadRequestException('Votre photo de profil est le selfie de votre dossier');
      changes.avatarUrl = dto.avatarUrl;
    }

    const phoneChange = dto.phone !== undefined && dto.phone !== user.phone;
    if (phoneChange || dto.newPassword) {
      if (user.role === Role.SUPER_ADMIN) throw new BadRequestException('Le compte Super Admin se modifie dans le fichier .env du serveur');
      if (!dto.currentPassword || !(await bcrypt.compare(dto.currentPassword, user.passwordHash))) {
        throw new BadRequestException('Mot de passe actuel incorrect');
      }
    }
    if (phoneChange) {
      if (await this.users.existsBy({ phone: dto.phone })) throw new ConflictException('Ce numéro est déjà utilisé');
      changes.phone = dto.phone;
    }
    if (dto.newPassword) changes.passwordHash = await bcrypt.hash(dto.newPassword, 10);
    if (Object.keys(changes).length) await this.users.update(id, changes);
    return this.me(id);
  }

  async session(user: User) {
    const token = await this.jwt.signAsync({
      sub: user.id,
      role: user.role,
      companyId: user.companyId,
    });
    delete user.passwordHash;
    return { token, user };
  }
}
