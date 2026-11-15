import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { Role } from '../users/user.entity';

export const IS_PUBLIC = 'isPublic';
export const ROLES = 'roles';

/** Route accessible sans connexion */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Route réservée à certains rôles */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

export interface AuthUser {
  sub: string;
  role: Role;
  companyId: string | null;
}

/** Utilisateur connecté (contenu du token JWT) */
export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user,
);
