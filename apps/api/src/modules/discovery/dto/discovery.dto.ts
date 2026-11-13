import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { MAX_TRIAL_DAYS } from '../../listing/listing';
import { SALON_TYPES, SalonType } from '../../salons/salon.types';
import { DISCOVERY_LIMITS, DISCOVERY_SORTS, DiscoverySort } from '../discovery.types';

const trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
/** '' (an empty form field) means "not sent", never 0. */
const num = () => Transform(({ value }) => (value === '' || value === undefined || value === null ? undefined : Number(value)));
const SAFE_TEXT = /^[^<>\u0000-\u0008\u000B\u000C\u000E-\u001F]*$/;
const safe = () => Matches(SAFE_TEXT, { message: '$property contains characters that are not allowed' });
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** GET /public/discovery/salons. Every field is optional; nothing here is trusted beyond validation. */
export class DiscoverySearchQuery {
  /** Salon name, area or a service the salon offers. */
  @IsOptional() @trim() @IsString() @MaxLength(80) @safe() q?: string;
  @IsOptional() @trim() @IsString() @MaxLength(80) @safe() city?: string;
  @IsOptional() @trim() @IsString() @MaxLength(80) @safe() area?: string;
  @IsOptional() @IsIn(SALON_TYPES) type?: SalonType;
  /** Service or category name. */
  @IsOptional() @trim() @IsString() @MaxLength(80) @safe() service?: string;
  /** Staff member name. */
  @IsOptional() @trim() @IsString() @MaxLength(80) @safe() staff?: string;
  @IsOptional() @num() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(DISCOVERY_LIMITS.maxPrice) minPrice?: number;
  @IsOptional() @num() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(DISCOVERY_LIMITS.maxPrice) maxPrice?: number;
  /** YYYY-MM-DD (Asia/Karachi). */
  @IsOptional() @Matches(ISO_DATE, { message: 'date must be YYYY-MM-DD' }) date?: string;
  /** HH:MM, only together with `date`. */
  @IsOptional() @Matches(CLOCK, { message: 'time must be HH:MM' }) time?: string;
  /** Location is OPTIONAL. It is used for this request only: never stored, never logged. */
  @IsOptional() @num() @IsNumber() @Min(-90) @Max(90) lat?: number;
  @IsOptional() @num() @IsNumber() @Min(-180) @Max(180) lng?: number;
  @IsOptional() @num() @IsNumber() @Min(0.1) @Max(DISCOVERY_LIMITS.maxRadiusKm) radiusKm?: number;
  @IsOptional() @IsIn(DISCOVERY_SORTS) sort?: DiscoverySort;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1_000) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(DISCOVERY_LIMITS.maxPageSize) pageSize?: number;
}

/** GET /public/discovery/salons/:id/availability */
export class AvailabilityQuery {
  @Matches(ISO_DATE, { message: 'date must be YYYY-MM-DD' }) date!: string;
  /** Comma-separated service ids (1 to 10). The staff shown are those who perform ALL of them. */
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',').map((s) => s.trim()).filter(Boolean) : value))
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(DISCOVERY_LIMITS.maxServicesPerPreview) @ArrayUnique() @IsUUID('all', { each: true })
  serviceIds!: string[];
  @IsOptional() @IsUUID() staffId?: string;
}

/** PUT /admin/discovery/settings */
export class UpdateDiscoverySettingsDto {
  @IsInt() @Min(0) @Max(MAX_TRIAL_DAYS) trialDays!: number;
}
