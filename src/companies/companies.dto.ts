import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { PersonDto, PHONE_MESSAGE, PHONE_REGEX } from '../common/dto';

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

/** Demande d'inscription d'une entreprise de livraison (depuis la landing page), validée ensuite par LETO */
export class ApplyCompanyDto extends CreateCompanyDto {
  @IsOptional() @IsString() @MaxLength(40) commune?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10000) drivers?: number;
  @IsOptional() @IsArray() @IsIn(['MOTO', 'CAR', 'CARGO'], { each: true }) vehicles?: string[];
  @IsOptional() @IsString() @MaxLength(800) message?: string;
}

export class ReviewNoteDto {
  @IsString() @IsNotEmpty({ message: 'Motif obligatoire' }) @MaxLength(500) note: string;
}

export class UpdateCompanyDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100) name?: string;
  @IsOptional() @Matches(PHONE_REGEX, { message: PHONE_MESSAGE }) phone?: string;
}

/** Nouveau livreur : identité et engin */
export class DriverDto extends PersonDto {
  @IsOptional() @IsIn(['MOTO', 'CAR', 'CARGO'], { message: 'Engin : moto, voiture ou cargo' }) vehicleType?: string;
}

/** Engin d'un livreur */
export class DriverVehicleDto {
  @IsIn(['MOTO', 'CAR', 'CARGO'], { message: 'Engin : moto, voiture ou cargo' }) vehicleType: string;
}

/** Engins dont dispose l'entreprise */
export class VehiclesDto {
  @IsArray() @ArrayMinSize(1, { message: 'Choisissez au moins un engin' }) @IsIn(['MOTO', 'CAR', 'CARGO'], { each: true }) vehicles: string[];
}
