import { IsEnum, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { PersonDto, PHONE_MESSAGE, PHONE_REGEX } from '../common/dto';
import { AccountType } from '../users/user.entity';

export class LoginDto {
  @Matches(PHONE_REGEX, { message: PHONE_MESSAGE })
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
  @Matches(PHONE_REGEX, { message: PHONE_MESSAGE })
  phone?: string;

  @IsOptional()
  @IsEnum(AccountType, { message: 'Type de compte : particulier ou boutique' })
  accountType?: AccountType;

  @IsOptional()
  @IsString()
  currentPassword?: string;

  @IsOptional()
  @IsString()
  @MinLength(6, { message: 'Nouveau mot de passe : 6 caractères minimum' })
  newPassword?: string;
}
