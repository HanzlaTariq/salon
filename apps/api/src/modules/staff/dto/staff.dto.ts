import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, Length,
  Matches, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { STAFF_LIMITS, STAFF_PERMISSIONS } from '../staff.types';

const trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
const lower = () => Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value));
/** Defence in depth for plain-text fields: no angle brackets and no control characters. */
const SAFE_TEXT = /^[^<>\u0000-\u0008\u000B\u000C\u000E-\u001F]*$/;
const safeText = () => Matches(SAFE_TEXT, { message: '$property contains characters that are not allowed' });
const HHMM = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Owner creates a roster entry. `self: true` adds the owner as a performing staff member (one per salon). */
export class CreateStaffMemberDto {
  @IsOptional() @IsBoolean() self?: boolean;
  @IsOptional() @trim() @IsString() @Length(2, 80) @safeText() displayName?: string;
  @IsOptional() @trim() @IsString() @MaxLength(300) @safeText() bio?: string | null;
  @IsOptional() @IsBoolean() performsServices?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(STAFF_PERMISSIONS.length) @ArrayUnique() @IsIn(STAFF_PERMISSIONS, { each: true })
  permissions?: string[];
}

/** Every field optional. `isActive: false` deactivates the account (sessions are revoked). */
export class UpdateStaffMemberDto {
  @IsOptional() @trim() @IsString() @Length(2, 80) @safeText() displayName?: string;
  @IsOptional() @trim() @IsString() @MaxLength(300) @safeText() bio?: string | null;
  @IsOptional() @IsBoolean() performsServices?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(STAFF_PERMISSIONS.length) @ArrayUnique() @IsIn(STAFF_PERMISSIONS, { each: true })
  permissions?: string[];
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class SendInvitationDto {
  @trim() @lower() @IsEmail({}, { message: 'Enter a valid e-mail address.' }) @MaxLength(254) email!: string;
}

export class DayHoursDto {
  @IsInt() @Min(1) @Max(7) weekday!: number;
  @IsBoolean() off!: boolean;
  @IsOptional() @Matches(HHMM, { message: 'startsAt must be HH:MM' }) startsAt?: string | null;
  @IsOptional() @Matches(HHMM, { message: 'endsAt must be HH:MM' }) endsAt?: string | null;
}

export class WeeklyHoursDto {
  @IsArray() @ArrayMinSize(7) @ArrayMaxSize(7) @ValidateNested({ each: true }) @Type(() => DayHoursDto) days!: DayHoursDto[];
}

export class BreakDto {
  @IsInt() @Min(1) @Max(7) weekday!: number;
  @Matches(HHMM, { message: 'startsAt must be HH:MM' }) startsAt!: string;
  @Matches(HHMM, { message: 'endsAt must be HH:MM' }) endsAt!: string;
  @IsOptional() @trim() @IsString() @Length(1, 60) @safeText() label?: string | null;
}

export class BreaksDto {
  @IsArray() @ArrayMaxSize(7 * STAFF_LIMITS.breaksPerDay) @ValidateNested({ each: true }) @Type(() => BreakDto) breaks!: BreakDto[];
}

export class LeaveDto {
  @Matches(ISO_DATE, { message: 'startsOn must be YYYY-MM-DD' }) startsOn!: string;
  @Matches(ISO_DATE, { message: 'endsOn must be YYYY-MM-DD' }) endsOn!: string;
  @IsOptional() @trim() @IsString() @Length(1, 200) @safeText() reason?: string | null;
}

export class LeaveDecisionDto {
  @IsIn(['APPROVE', 'REJECT']) decision!: 'APPROVE' | 'REJECT';
}

export class PreviewInvitationDto {
  @IsString() @Length(20, 200) token!: string;
}

export class AcceptInvitationDto {
  @IsString() @Length(20, 200) token!: string;
  @trim() @IsString() @Length(2, 120) @safeText() fullName!: string;
  @IsString() @Length(10, 128) password!: string;
}
