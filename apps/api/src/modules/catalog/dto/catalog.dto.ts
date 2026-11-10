import { PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min,
  ValidateNested,
} from 'class-validator';
import { CATALOG_LIMITS, MAX_DURATION_MIN, MAX_PRICE, MIN_DURATION_MIN, PRICING_MODES, PricingMode } from '../catalog.types';

const trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
/** Defence in depth for plain-text fields: no angle brackets and no control characters (newline/tab allowed). */
const SAFE_TEXT = /^[^<>\u0000-\u0008\u000B\u000C\u000E-\u001F]*$/;
const safeText = () => Matches(SAFE_TEXT, { message: '$property contains characters that are not allowed' });
const money = () => IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false });

export class CreateCategoryDto {
  @trim() @IsString() @Length(2, 60) @safeText() name!: string;
  @IsOptional() @trim() @IsString() @MaxLength(300) @safeText() description?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

/** All optional. `description: null` clears it. */
export class UpdateCategoryDto extends PartialType(CreateCategoryDto) {}

/** The complete list of the salon's category ids in the desired display order. */
export class ReorderCategoriesDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(CATALOG_LIMITS.categories) @IsUUID(undefined, { each: true }) ids!: string[];
}

export class PricingDto {
  @IsIn(PRICING_MODES) mode!: PricingMode;
  /** FIXED only: the salon-wide price in PKR. */
  @IsOptional() @money() @Min(0) @Max(MAX_PRICE) price?: number | null;
}

export class StaffAssignmentDto {
  @IsUUID() staffId!: string;
  /** STAFF_BASED only: this staff member's own price in PKR. */
  @IsOptional() @money() @Min(0) @Max(MAX_PRICE) price?: number | null;
}

export class CreateServiceDto {
  @IsUUID() categoryId!: string;
  @trim() @IsString() @Length(2, 100) @safeText() name!: string;
  @IsOptional() @trim() @IsString() @MaxLength(500) @safeText() description?: string | null;
  @IsInt() @Min(MIN_DURATION_MIN) @Max(MAX_DURATION_MIN) durationMinutes!: number;
  @ValidateNested() @Type(() => PricingDto) pricing!: PricingDto;
  /** The staff who perform this service (with their own price when the service is STAFF_BASED). */
  @IsOptional() @IsArray() @ArrayMaxSize(CATALOG_LIMITS.staffPerService) @ValidateNested({ each: true }) @Type(() => StaffAssignmentDto) staff?: StaffAssignmentDto[];
  @IsOptional() @IsBoolean() isActive?: boolean;
}

/** Every field optional. Sending `staff` REPLACES the whole assignment list. */
export class UpdateServiceDto {
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @trim() @IsString() @Length(2, 100) @safeText() name?: string;
  @IsOptional() @trim() @IsString() @MaxLength(500) @safeText() description?: string | null;
  @IsOptional() @IsInt() @Min(MIN_DURATION_MIN) @Max(MAX_DURATION_MIN) durationMinutes?: number;
  @IsOptional() @ValidateNested() @Type(() => PricingDto) pricing?: PricingDto;
  @IsOptional() @IsArray() @ArrayMaxSize(CATALOG_LIMITS.staffPerService) @ValidateNested({ each: true }) @Type(() => StaffAssignmentDto) staff?: StaffAssignmentDto[];
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class CreateStaffDto {
  /** true: add the owner as a staff member (the owner then counts as ONE staff member). */
  @IsOptional() @IsBoolean() self?: boolean;
  @IsOptional() @trim() @IsString() @Length(2, 80) @safeText() displayName?: string;
}

export class UpdateStaffDto {
  @IsOptional() @trim() @IsString() @Length(2, 80) @safeText() displayName?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
