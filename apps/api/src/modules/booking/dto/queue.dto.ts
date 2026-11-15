import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { BOOKING_LIMITS } from '../booking.types';
import { QUEUE_LIMITS } from '../queue.types';

const trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
const SAFE_TEXT = /^[^<>\u0000-\u0008\u000B\u000C\u000E-\u001F]*$/;
const safe = () => Matches(SAFE_TEXT, { message: '$property contains characters that are not allowed' });
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const eta = () => [Type(() => Number), IsInt(), Min(QUEUE_LIMITS.arrivalEtaMinMinutes), Max(QUEUE_LIMITS.arrivalEtaMaxMinutes)];
const apply = (...d: PropertyDecorator[]): PropertyDecorator => (t, k) => d.forEach((f) => f(t, k));

/** GET /salons/mine/queue. Staff never send a staff id: their own lane is derived from the session. */
export class OwnerQueueQuery {
  @IsOptional() @IsUUID() staffId?: string;
}

/** Fields shared by both walk-in bodies. Price, duration and names of the services are NEVER accepted: the server derives them. */
class WalkInBase {
  @trim() @IsString() @MinLength(QUEUE_LIMITS.walkInNameMinLength) @MaxLength(QUEUE_LIMITS.walkInNameMaxLength) @safe() customerName!: string;
  @IsOptional() @trim() @IsString() @MaxLength(20) phone?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(BOOKING_LIMITS.maxServices) @ArrayUnique() @IsUUID('all', { each: true }) serviceIds!: string[];
  @IsOptional() @trim() @IsString() @MaxLength(QUEUE_LIMITS.walkInNoteMaxLength) @safe() note?: string;
}
export class StaffWalkInDto extends WalkInBase {}
export class OwnerWalkInDto extends WalkInBase {
  @IsUUID() staffId!: string;
}

export class StaffNextDto {
  /** The current service is completed ONLY when this is true. Without it the API refuses with CURRENT_IN_PROGRESS. */
  @IsOptional() @IsBoolean() completeCurrent?: boolean;
}
export class OwnerNextDto extends StaffNextDto {
  @IsUUID() staffId!: string;
}

export class NoShowDto {
  @IsOptional() @trim() @IsString() @MaxLength(BOOKING_LIMITS.reasonMaxLength) @safe() reason?: string;
}

export class EarlyOfferDto {
  /** HH:MM (Karachi). Left out: the earliest possible time. */
  @IsOptional() @Matches(CLOCK, { message: 'time must be HH:MM' }) time?: string;
}

export class ArrivalDto {
  @IsIn(['ON_THE_WAY', 'RUNNING_LATE']) state!: 'ON_THE_WAY' | 'RUNNING_LATE';
  /** "I will be there in N minutes" (quick choices 5, 10, 15, 20, 30 or any whole number up to 120). Required for RUNNING_LATE. */
  @IsOptional() @apply(...eta()) etaMinutes?: number;
}

export class AnswerOfferDto {
  @IsUUID() offerId!: string;
  /** Accept only: "I am coming, N minutes". Stored as the customer's own ETA, separate from the offered time. */
  @IsOptional() @apply(...eta()) etaMinutes?: number;
}
