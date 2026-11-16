import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

export class RegisterDeviceDto {
  /** The FCM registration token of this device. */
  @IsString() @MinLength(20) @MaxLength(4096) token!: string;
  @IsIn(['ANDROID', 'IOS']) platform!: 'ANDROID' | 'IOS';
  @IsIn(['CUSTOMER', 'BUSINESS']) app!: 'CUSTOMER' | 'BUSINESS';
  @IsOptional() @IsString() @MaxLength(20) @Matches(/^[\w.+-]+$/) appVersion?: string;
}

export class UnregisterDeviceDto {
  @IsString() @MinLength(20) @MaxLength(4096) token!: string;
}

export class InboxQuery {
  @IsOptional() @Transform(({ value }) => (value === undefined ? undefined : Number(value))) @IsInt() @Min(1) @Max(50) limit?: number;
  /** Opaque cursor returned as `nextCursor` by the previous page. */
  @IsOptional() @IsString() @MaxLength(120) cursor?: string;
  @IsOptional() @Transform(({ value }) => value === 'true' || value === true) @IsBoolean() unread?: boolean;
}

export class UpdatePreferencesDto {
  @IsBoolean() pushEnabled!: boolean;
  @IsIn(['en', 'ur']) language!: 'en' | 'ur';
  @IsBoolean() bookings!: boolean;
  @IsBoolean() reminders!: boolean;
  @IsBoolean() queue!: boolean;
  @IsBoolean() team!: boolean;
  /** Minutes before the appointment; any of 30, 20, 10 and 0 (= at the appointment time); duplicates are ignored. */
  @IsArray() @ArrayMaxSize(4) @IsIn([0, 10, 20, 30], { each: true }) reminderOffsets!: number[];
}
