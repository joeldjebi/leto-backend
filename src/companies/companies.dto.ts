import { ArrayMinSize, IsArray, IsIn, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { PHONE_MESSAGE, PHONE_REGEX } from '../common/dto';

export class CreateCompanyDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @Matches(PHONE_REGEX, { message: `Téléphone de l’entreprise : ${PHONE_MESSAGE}` })
  phone: string;

  /** Compte du gérant créé en même temps que l'entreprise */
  @IsString()
  @IsNotEmpty({ message: 'Nom du gérant obligatoire' })
  managerName: string;

  @Matches(PHONE_REGEX, { message: `Téléphone du gérant : ${PHONE_MESSAGE}` })
  managerPhone: string;

  @IsString()
  @MinLength(6, { message: 'Mot de passe du gérant : 6 caractères minimum' })
  managerPassword: string;
}

export class UpdateCompanyDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100) name?: string;
  @IsOptional() @Matches(PHONE_REGEX, { message: PHONE_MESSAGE }) phone?: string;
}

/** Engins dont dispose l'entreprise */
export class VehiclesDto {
  @IsArray() @ArrayMinSize(1, { message: 'Choisissez au moins un engin' }) @IsIn(['MOTO', 'CAR', 'CARGO'], { each: true }) vehicles: string[];
}
