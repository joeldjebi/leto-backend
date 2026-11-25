import { IsPhone, PHONE_MESSAGE } from '../countries/phone';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  ValidateIf,
  IsUUID,
  IsBoolean,
  IsEnum,
  IsIn,
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
  @IsPhone({ message: PHONE_MESSAGE }) recipientPhone: string;
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
  @IsPhone({ message: PHONE_MESSAGE }) pickupPhone: string;
  @IsOptional() @Matches(PHOTO_REGEX) pickupPhotoUrl?: string;

  /** Entreprise choisie par le client (sa grille tarifaire, ses livreurs seulement) ; absent = toutes */
  @IsOptional() @IsUUID() companyId?: string;
  /** Le client choisit les livreurs indépendants (au lieu d'une entreprise) */
  @IsOptional() @IsBoolean() forIndependents?: boolean;

  // ----- Arrêts (1 à MAX_STOPS) -----
  @IsArray()
  @ArrayMinSize(1, { message: 'Ajoutez au moins une adresse de livraison' })
  @ArrayMaxSize(MAX_STOPS, { message: `${MAX_STOPS} adresses maximum par tournée` })
  @ValidateNested({ each: true })
  @Type(() => StopDto)
  stops: StopDto[];

  @IsOptional() @IsString() @MaxLength(500) courierComment?: string;

  /** Garder l'ordre des arrêts tel que saisi (sinon ordre de passage optimisé) */
  @IsOptional() @IsBoolean() keepOrder?: boolean;
}

export class ConfirmStopDto {
  /** Facultatif si l'admin a désactivé la confirmation par code */
  @IsOptional()
  @Length(4, 4, { message: 'Le code fait 4 chiffres' })
  code?: string;
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

/** Course créée par une entreprise (commande reçue par téléphone, WhatsApp…) */
export class CompanyOrderDto extends CreateDeliveryDto {
  @IsString() @IsNotEmpty({ message: 'Nom du client obligatoire' }) @MaxLength(100) clientName: string;
  @IsPhone({ message: PHONE_MESSAGE }) clientPhone: string;
  /** Livreur à qui affecter la course (sinon visible par tous les livreurs de l'entreprise) */
  @IsOptional() @IsUUID() driverId?: string;
  /** Prix fixé à la main (sinon grille de l'entreprise) */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(1_000_000) price?: number;
}

export class AssignDto {
  @ValidateIf((o) => o.driverId !== null) @IsUUID() driverId: string | null;
}

export class DeclineAssignmentDto {
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

export class CancelStopDto {
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

export class CancelRequestDto {
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

export class AnswerCancelDto {
  @IsBoolean() accept: boolean;
}

export class ReturnDto {
  @Matches(/^\d{4}$/, { message: 'Code de retour : 4 chiffres' }) code: string;
}

export class DisputeStopDto {
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

/** L'entreprise fixe l'ordre de passage des arrêts encore à livrer */
export class ReorderStopsDto {
  @IsArray() @ArrayMinSize(1) @IsUUID('all', { each: true }) stopIds: string[];
}

/** Compliments proposés au client après une livraison (bonne note) ou points à améliorer (note basse) */
export const RATING_TAGS = ['FAST', 'POLITE', 'CAREFUL', 'COMMUNICATION', 'ABOVE', 'LATE', 'RUDE', 'DAMAGED', 'UNREACHABLE', 'ROUTE'] as const;

export class RateDto {
  @IsInt() @Min(1, { message: 'Note : 1 à 5 étoiles' }) @Max(5, { message: 'Note : 1 à 5 étoiles' }) stars: number;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsIn(RATING_TAGS as unknown as string[], { each: true }) tags?: string[];
  @IsOptional() @IsString() @MaxLength(500) comment?: string;
}

/** Tournée du livreur : clés des étapes dans l'ordre voulu */
export class PlanDto {
  @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) @MaxLength(80, { each: true }) keys: string[];
}

export class AlertResponseDto {
  @IsIn(['DECLINED', 'EXPIRED']) action: 'DECLINED' | 'EXPIRED';
}
