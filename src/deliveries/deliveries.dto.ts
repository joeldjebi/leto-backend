import { Type } from 'class-transformer';
import {
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
} from 'class-validator';
import { PHONE_MESSAGE, PHONE_REGEX } from '../common/dto';
import { DeliverySpeed, VehicleType } from '../pricing/pricing';

const PHOTO_REGEX = /^\/uploads\/[\w.-]+$/;

export class CreateDeliveryDto {
  // ----- Offre -----
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

  // ----- Arrivée -----
  @IsLatitude() dropoffLat: number;
  @IsLongitude() dropoffLng: number;
  @IsString() @IsNotEmpty() @MaxLength(200) dropoffAddress: string;
  @IsOptional() @IsString() @MaxLength(500) dropoffDetails?: string;
  @IsString() @IsNotEmpty() @MaxLength(100) recipientName: string;
  @Matches(PHONE_REGEX, { message: PHONE_MESSAGE }) recipientPhone: string;
  @IsOptional() @Matches(PHOTO_REGEX) dropoffPhotoUrl?: string;

  // ----- Colis -----
  @IsOptional() @IsString() @MaxLength(500) packageDescription?: string;
  @IsOptional() @IsString() @MaxLength(500) courierComment?: string;

  /** Paiement à la livraison : montant de la marchandise à encaisser (FCFA) */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(5_000_000)
  codAmount?: number;
}

export class ConfirmDeliveryDto {
  @Length(4, 4, { message: 'Le code fait 4 chiffres' })
  code: string;
}
