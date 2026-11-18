import { IsNotEmpty, IsString, MinLength } from 'class-validator';

import { IsPhone, PHONE_MESSAGE } from '../countries/phone';

export { PHONE_MESSAGE };

export class PersonDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsPhone({ message: PHONE_MESSAGE })
  phone: string;

  @IsString()
  @MinLength(6, { message: 'Mot de passe : 6 caractères minimum' })
  password: string;
}
