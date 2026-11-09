import { UserRole, UserStatus } from '../../common/auth/roles';

export interface PublicUser {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  role: UserRole;
  status: UserStatus;
  emailVerified: boolean;
  mfaEnabled: boolean;
}

export interface AuthResult {
  accessToken: string;
  expiresIn: number;
  /** Returned in the body for mobile clients; for web the controller moves it into an httpOnly cookie. */
  refreshToken: string;
  user: PublicUser;
  /** True when this (platform) account must enrol MFA before using anything else. */
  mfaEnrollmentRequired: boolean;
}
