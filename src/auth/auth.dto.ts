import { IsString, Matches } from 'class-validator';
import { PHONE_MESSAGE, PHONE_REGEX } from '../common/dto';

export class LoginDto {
  @Matches(PHONE_REGEX, { message: PHONE_MESSAGE })
  phone: string;

  @IsString()
  password: string;
}
