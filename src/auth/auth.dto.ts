import { IsPhone, PHONE_MESSAGE } from '../countries/phone';
import { IsEnum, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';
import {PersonDto} from '../common/dto';
import { AccountType } from '../users/user.entity';

export class LoginDto {
  @IsPhone({ anyCountry: true, message: PHONE_MESSAGE })
  phone: string;

  @IsString()
  password: string;
}

/** Inscription d'un client : particulier ou boutique */
export class RegisterDto extends PersonDto {
  @IsEnum(AccountType, { message: 'Précisez si vous êtes un particulier ou une boutique' })
  accountType: AccountType;
}

/** Mise à jour de son profil (le mot de passe actuel est demandé pour changer de mot de passe ou de numéro) */
export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Nom obligatoire' })
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsPhone({ message: PHONE_MESSAGE })
  phone?: string;

  @IsOptional()
  @IsEnum(AccountType, { message: 'Type de compte : particulier ou boutique' })
  accountType?: AccountType;

  /** Photo de profil (chemin renvoyé par /uploads), null pour la retirer */
  @IsOptional()
  @ValidateIf((o) => o.avatarUrl !== null)
  @Matches(/^\/uploads\/[0-9a-f-]{36}\.(jpg|png|webp|heic)$/, { message: 'Photo invalide' })
  avatarUrl?: string | null;

  /** Immatriculation de l'engin (livreurs d'entreprise ; "" pour l'effacer) */
  @IsOptional()
  @IsString()
  @MaxLength(20, { message: 'Immatriculation : 20 caractères maximum' })
  plate?: string;

  @IsOptional()
  @IsString()
  currentPassword?: string;

  @IsOptional()
  @IsString()
  @MinLength(6, { message: 'Nouveau mot de passe : 6 caractères minimum' })
  newPassword?: string;
}
