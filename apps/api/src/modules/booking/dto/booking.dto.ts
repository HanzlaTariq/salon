import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { BOOKING_LIMITS, BOOKING_POLICY_RANGES } from '../booking.types';

const trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
const SAFE_TEXT = /^[^<>\u0000-\u0008\u000B\u000C\u000E-\u001F]*$/;
const safe = () => Matches(SAFE_TEXT, { message: '$property contains characters that are not allowed' });
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const BUFFERS = Array.from({ length: BOOKING_POLICY_RANGES.bufferMinutes.max / 5 + 1 }, (_, i) => i * 5);
export const BOOKING_STATUS_FILTER = ['PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'DELAYED'] as const;

/** POST /bookings. Price, duration and names are NEVER accepted: the server derives them. */
export class CreateBookingDto {
  @IsUUID() salonId!: string;
  @IsUUID() staffId!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(BOOKING_LIMITS.maxServices) @ArrayUnique() @IsUUID('all', { each: true }) serviceIds!: string[];
  /** YYYY-MM-DD, Asia/Karachi. */
  @Matches(ISO_DATE, { message: 'date must be YYYY-MM-DD' }) date!: string;
  /** HH:MM (24 h, Asia/Karachi), on a 5-minute mark. */
  @Matches(CLOCK, { message: 'time must be HH:MM' }) time!: string;
  @IsOptional() @trim() @IsString() @MaxLength(BOOKING_LIMITS.noteMaxLength) @safe() note?: string;
}

export class RescheduleBookingDto {
  @Matches(ISO_DATE, { message: 'date must be YYYY-MM-DD' }) date!: string;
  @Matches(CLOCK, { message: 'time must be HH:MM' }) time!: string;
}

export class CustomerCancelDto {
  @IsOptional() @trim() @IsString() @MaxLength(BOOKING_LIMITS.reasonMaxLength) @safe() reason?: string;
}

export class SalonCancelDto {
  @trim() @IsString() @MinLength(BOOKING_LIMITS.reasonMinLength) @MaxLength(BOOKING_LIMITS.reasonMaxLength) @safe() reason!: string;
}

export class ListBookingsQuery {
  @IsOptional() @IsIn(['upcoming', 'past', 'all']) scope?: 'upcoming' | 'past' | 'all';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1_000) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(BOOKING_LIMITS.maxPageSize) pageSize?: number;
}

/** GET /salons/mine/bookings and GET /staff/me/bookings. Dates are inclusive, Asia/Karachi; default is today only. */
export class SalonBookingsQuery {
  @IsOptional() @Matches(ISO_DATE, { message: 'from must be YYYY-MM-DD' }) from?: string;
  @IsOptional() @Matches(ISO_DATE, { message: 'to must be YYYY-MM-DD' }) to?: string;
  @IsOptional() @IsUUID() staffId?: string;
  @IsOptional() @IsIn(BOOKING_STATUS_FILTER) status?: (typeof BOOKING_STATUS_FILTER)[number];
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1_000) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}

/** PUT /salons/mine/booking-policy: all six rules, always. */
export class UpdateBookingPolicyDto {
  @IsInt() @IsIn(BUFFERS) bufferMinutes!: number;
  @IsInt() @Min(BOOKING_POLICY_RANGES.minNoticeMinutes.min) @Max(BOOKING_POLICY_RANGES.minNoticeMinutes.max) minNoticeMinutes!: number;
  @IsInt() @Min(BOOKING_POLICY_RANGES.advanceDays.min) @Max(BOOKING_POLICY_RANGES.advanceDays.max) advanceDays!: number;
  @IsInt() @Min(BOOKING_POLICY_RANGES.cancelCutoffMinutes.min) @Max(BOOKING_POLICY_RANGES.cancelCutoffMinutes.max) cancelCutoffMinutes!: number;
  @IsInt() @Min(BOOKING_POLICY_RANGES.rescheduleCutoffMinutes.min) @Max(BOOKING_POLICY_RANGES.rescheduleCutoffMinutes.max) rescheduleCutoffMinutes!: number;
  @IsInt() @Min(BOOKING_POLICY_RANGES.maxReschedules.min) @Max(BOOKING_POLICY_RANGES.maxReschedules.max) maxReschedules!: number;
}
