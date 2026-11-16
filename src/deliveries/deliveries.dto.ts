import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PHONE_MESSAGE, PHONE_REGEX } from '../common/dto';
import { DeliverySpeed, MAX_STOPS, VehicleType } from '../pricing/pricing';
import { DisputeDecision, FailureReason } from './delivery-stop.entity';

export const PHOTO_REGEX = /^\/uploads\/[\w.-]+$/;

export class StopDto {
  @IsLatitude() lat: number;
  @IsLongitude() lng: number;
  @IsString() @IsNotEmpty() @MaxLength(200) address: string;
  @IsOptional() @IsString() @MaxLength(500) details?: string;
  @IsOptional() @Matches(PHOTO_REGEX) photoUrl?: string;
  @IsString() @IsNotEmpty() @MaxLength(100) recipientName: string;
  @Matches(PHONE_REGEX, { message: PHONE_MESSAGE }) recipientPhone: string;
  @IsOptional() @IsString() @MaxLength(300) packageDescription?: string;

  /** Paiement à la livraison : montant de la marchandise à encaisser (FCFA) */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(5_000_000)
  codAmount?: number;
}

export class CreateDeliveryDto {
  @IsOptional() @IsEnum(VehicleType) vehicleType?: VehicleType;
  @IsOptional() @IsEnum(DeliverySpeed) speed?: DeliverySpeed;

  // ----- Départ -----
  @IsLatitude() pickupLat: number;
  @IsLongitude() pickupLng: number;
  @IsString() @IsNotEmpty() @MaxLength(200) pickupAddress: string;
  @IsOptional() @IsString() @MaxLength(500) pickupDetails?: string;
  @IsOptional() @IsString() @MaxLength(100) pickupContactName?: string;
  @Matches(PHONE_REGEX, { message: PHONE_MESSAGE }) pickupPhone: string;
  @IsOptional() @Matches(PHOTO_REGEX) pickupPhotoUrl?: string;

  // ----- Arrêts (1 à MAX_STOPS) -----
  @IsArray()
  @ArrayMinSize(1, { message: 'Ajoutez au moins une adresse de livraison' })
  @ArrayMaxSize(MAX_STOPS, { message: `${MAX_STOPS} adresses maximum par tournée` })
  @ValidateNested({ each: true })
  @Type(() => StopDto)
  stops: StopDto[];

  @IsOptional() @IsString() @MaxLength(500) courierComment?: string;
}

export class ConfirmStopDto {
  @Length(4, 4, { message: 'Le code fait 4 chiffres' })
  code: string;
}

export class FailStopDto {
  @IsEnum(FailureReason) reason: FailureReason;
  /** Photo obligatoire du lieu (porte, portail…) */
  @Matches(PHOTO_REGEX, { message: 'Photo du lieu obligatoire' }) photoUrl: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

export class ResolveDisputeDto {
  @IsEnum(DisputeDecision) decision: DisputeDecision;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class AdminCancelDto {
  @IsString() @IsNotEmpty() @MaxLength(300) reason: string;
}

export class DisputeStopDto {
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
