import { PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEmail, IsIn, IsInt, IsNumber, IsOptional, IsString, Length, Matches, Max, MaxLength, Min,
} from 'class-validator';
import { normalizePhone } from '../../../common/util/phone';
import { DOCUMENT_TYPES, FILE_KINDS, FileKind, FileDocType, PHOTO_TYPES, SALON_STATUSES, SALON_TYPES, SalonStatus, SalonType } from '../salon.types';

const trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
const lowerEmail = () => Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value));
/** Pakistani local formats are converted to E.164; anything else must already be +<country><number>. */
const phone = () => Transform(({ value }) => (typeof value === 'string' ? (normalizePhone(value) ?? value.trim()) : value));

/** Defence in depth for plain-text fields: no angle brackets and no control characters (newline/tab allowed). */
const SAFE_TEXT = /^[^<>\u0000-\u0008\u000B\u000C\u000E-\u001F]*$/;
const safeText = () => Matches(SAFE_TEXT, { message: '$property contains characters that are not allowed' });

export class CreateSalonDto {
  @trim() @IsString() @Length(2, 120) @safeText() name!: string;
  @IsIn(SALON_TYPES) salonType!: SalonType;
  @trim() @IsString() @Length(2, 80) @safeText() city!: string;
  @trim() @IsString() @Length(2, 80) @safeText() area!: string;
  @trim() @IsString() @Length(5, 250) @safeText() addressLine!: string;
  @phone() @IsString() @Matches(/^\+[1-9]\d{7,14}$/, { message: 'phone must be a valid phone number' }) phone!: string;
  @IsOptional() @lowerEmail() @IsEmail() @MaxLength(254) contactEmail?: string;
  @IsOptional() @trim() @IsString() @MaxLength(1000) @safeText() description?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 6 }) @Min(-90) @Max(90) latitude?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 6 }) @Min(-180) @Max(180) longitude?: number;
}

/** Every field optional; unknown fields (status, ownerUserId, approvedAt, ...) are rejected by the global pipe. */
export class UpdateSalonDto extends PartialType(CreateSalonDto) {}

export class UploadFileDto {
  @IsIn(FILE_KINDS) kind!: FileKind;
  @IsIn([...DOCUMENT_TYPES, ...PHOTO_TYPES]) docType!: FileDocType;
}

export class ReasonDto {
  @trim() @IsString() @Length(5, 500) @safeText() reason!: string;
}

export class RejectDto {
  @trim() @IsString() @Length(10, 500) @safeText() reason!: string;
}

export class AdminListSalonsQuery {
  @IsOptional() @IsIn(SALON_STATUSES.filter((s) => s !== 'DRAFT')) status?: Exclude<SalonStatus, 'DRAFT'>;
  @IsOptional() @trim() @IsString() @MaxLength(80) q?: string;
  @IsOptional() @trim() @IsString() @MaxLength(80) city?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10_000) page?: number;
}

export class PublicListSalonsQuery {
  @IsOptional() @trim() @IsString() @MaxLength(80) q?: string;
  @IsOptional() @trim() @IsString() @MaxLength(80) city?: string;
  @IsOptional() @trim() @IsString() @MaxLength(80) area?: string;
  @IsOptional() @IsIn(SALON_TYPES) type?: SalonType;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) pageSize?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1_000) page?: number;
}
