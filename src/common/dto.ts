import { IsNotEmpty, IsString, Matches, MinLength } from 'class-validator';

/** Numéro ivoirien à 10 chiffres, ex : 0701020304 */
export const PHONE_REGEX = /^0\d{9}$/;
export const PHONE_MESSAGE = 'Numéro invalide (10 chiffres, ex : 0701020304)';

export class PersonDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @Matches(PHONE_REGEX, { message: PHONE_MESSAGE })
  phone: string;

  @IsString()
  @MinLength(6, { message: 'Mot de passe : 6 caractères minimum' })
  password: string;
}
