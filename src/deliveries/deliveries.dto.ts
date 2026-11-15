import {
  IsIn,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';
import { PHONE_MESSAGE, PHONE_REGEX } from '../common/dto';
import { COMMUNES } from '../pricing/pricing';

export class CreateDeliveryDto {
  @IsIn(COMMUNES as readonly string[], { message: 'Commune de départ inconnue' })
  pickupCommune: string;

  @IsString()
  @IsNotEmpty()
  pickupAddress: string;

  @Matches(PHONE_REGEX, { message: PHONE_MESSAGE })
  pickupPhone: string;

  @IsIn(COMMUNES as readonly string[], { message: "Commune d'arrivée inconnue" })
  dropoffCommune: string;

  @IsString()
  @IsNotEmpty()
  dropoffAddress: string;

  @IsString()
  @IsNotEmpty()
  recipientName: string;

  @Matches(PHONE_REGEX, { message: PHONE_MESSAGE })
  recipientPhone: string;

  @IsOptional()
  @IsString()
  packageDescription?: string;

  @IsOptional() @IsLatitude() pickupLat?: number;
  @IsOptional() @IsLongitude() pickupLng?: number;
  @IsOptional() @IsLatitude() dropoffLat?: number;
  @IsOptional() @IsLongitude() dropoffLng?: number;
}

export class ConfirmDeliveryDto {
  @Length(4, 4, { message: 'Le code fait 4 chiffres' })
  code: string;
}
