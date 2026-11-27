import { IsPhone, PHONE_MESSAGE } from '../countries/phone';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';
import {PersonDto} from '../common/dto';

export class CreateCompanyDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsPhone({ message: `Téléphone de l’entreprise : ${PHONE_MESSAGE}` })
  phone: string;

  /** Compte du gérant créé en même temps que l'entreprise */
  @IsString()
  @IsNotEmpty({ message: 'Nom du gérant obligatoire' })
  managerName: string;

  @IsPhone({ message: `Téléphone du gérant : ${PHONE_MESSAGE}` })
  managerPhone: string;

  @IsString()
  @MinLength(6, { message: 'Mot de passe du gérant : 6 caractères minimum' })
  managerPassword: string;
}

/** Demande d'inscription d'une entreprise de livraison (depuis la landing page), validée ensuite par VITE */
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
  @IsPhone({ optional: true, message: PHONE_MESSAGE }) phone?: string;
}

/** Nouveau livreur : identité et engin */
export class DriverDto extends PersonDto {
  @IsOptional() @IsIn(['MOTO', 'CAR', 'CARGO'], { message: 'Engin : moto, voiture ou cargo' }) vehicleType?: string;
  @IsOptional() @IsString() @MaxLength(20, { message: 'Immatriculation : 20 caractères maximum' }) plate?: string;
}

/** Engin d'un livreur */
export class DriverVehicleDto {
  @IsIn(['MOTO', 'CAR', 'CARGO'], { message: 'Engin : moto, voiture ou cargo' }) vehicleType: string;
  /** Immatriculation ("" pour l'effacer) */
  @IsOptional() @IsString() @MaxLength(20, { message: 'Immatriculation : 20 caractères maximum' }) plate?: string;
}

/** Engins dont dispose l'entreprise */
export class VehiclesDto {
  @IsArray() @ArrayMinSize(1, { message: 'Choisissez au moins un engin' }) @IsIn(['MOTO', 'CAR', 'CARGO'], { each: true }) vehicles: string[];
}

class OpeningHoursDto {
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'Heure d’ouverture : HH:MM' }) open: string;
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'Heure de fermeture : HH:MM' }) close: string;
  @IsArray() @ArrayMinSize(1, { message: 'Choisissez au moins un jour' }) @IsInt({ each: true }) @Min(1, { each: true }) @Max(7, { each: true }) days: number[];
}

/** Gérant : ouverture aux commandes des clients */
export class AvailabilityDto {
  @IsOptional() @IsBoolean() acceptingOrders?: boolean;
  @IsOptional() @ValidateIf((_, v) => v !== null) @ValidateNested() @Type(() => OpeningHoursDto) openingHours?: OpeningHoursDto | null;
}

/** SA : accès des livreurs de l'entreprise aux commandes ouvertes */
export class OrderAccessDto {
  @IsOptional() @IsBoolean() openOrders?: boolean;
  @IsOptional() @IsBoolean() liOpenOrders?: boolean;
}
