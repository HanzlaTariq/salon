import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsIn, IsOptional, IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';
import { SELF_REGISTRATION_ROLES, SelfRegistrationRole } from '../../../common/auth/roles';

const normEmail = () => Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value));
const trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export class RegisterDto {
  @normEmail() @IsEmail() @MaxLength(254) email!: string;
  /** Length bounds protect the hashing cost; strength rules live in PasswordService. */
  @IsString() @MinLength(10) @MaxLength(128) password!: string;
  @trim() @IsString() @Length(2, 120) fullName!: string;
  @IsOptional() @trim() @IsString() @MaxLength(25) phone?: string;
  /** Only CUSTOMER or SALON_OWNER. Any other value (e.g. SUPER_ADMIN) is rejected with 400. */
  @IsIn(SELF_REGISTRATION_ROLES) accountType!: SelfRegistrationRole;
}

export class LoginDto {
  @normEmail() @IsEmail() @MaxLength(254) email!: string;
  @IsString() @MinLength(1) @MaxLength(128) password!: string;
  /** 6-digit authenticator code, or a recovery code. */
  @IsOptional() @IsString() @MaxLength(32) mfaCode?: string;
}

export class TokenOnlyDto {
  @IsString() @Length(20, 200) token!: string;
}

export class EmailOnlyDto {
  @normEmail() @IsEmail() @MaxLength(254) email!: string;
}

export class RefreshDto {
  /** Mobile clients only (web uses the httpOnly cookie). */
  @IsOptional() @IsString() @Length(20, 200) refreshToken?: string;
}

export class ResetPasswordDto {
  @IsString() @Length(20, 200) token!: string;
  @IsString() @MinLength(10) @MaxLength(128) newPassword!: string;
}

export class ChangePasswordDto {
  @IsString() @MinLength(1) @MaxLength(128) currentPassword!: string;
  @IsString() @MinLength(10) @MaxLength(128) newPassword!: string;
}

export class MfaSetupDto {
  @IsString() @MinLength(1) @MaxLength(128) password!: string;
}

export class MfaEnableDto {
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' }) code!: string;
}

export class MfaDisableDto {
  @IsString() @MinLength(1) @MaxLength(128) password!: string;
  @IsString() @MaxLength(32) code!: string;
}

export class LogoutAllDto {
  @IsOptional() @IsBoolean() keepCurrent?: boolean;
}
