import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { PHONE_MESSAGE, PHONE_REGEX } from '../common/dto';

export class CreateCompanyDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @Matches(PHONE_REGEX, { message: PHONE_MESSAGE })
  phone: string;

  /** Compte du gérant créé en même temps que l'entreprise */
  @IsString()
  @IsNotEmpty()
  managerName: string;

  @Matches(PHONE_REGEX, { message: PHONE_MESSAGE })
  managerPhone: string;

  @IsString()
  @MinLength(6)
  managerPassword: string;
}

export class UpdateCompanyDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100) name?: string;
  @IsOptional() @Matches(PHONE_REGEX, { message: PHONE_MESSAGE }) phone?: string;
}
