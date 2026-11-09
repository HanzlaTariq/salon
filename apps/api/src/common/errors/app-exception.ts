import { HttpException, HttpStatus } from '@nestjs/common';

/** Stable, machine-readable error codes shared with all clients (web + Flutter). */
export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'SLOT_TAKEN'
  | 'INVALID_CREDENTIALS'
  | 'MFA_REQUIRED'
  | 'MFA_ENROLLMENT_REQUIRED'
  | 'ACCOUNT_SUSPENDED'
  | 'EMAIL_NOT_VERIFIED'
  | 'TOKEN_INVALID'
  | 'CSRF_REJECTED'
  | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'INTERNAL_ERROR'
  | 'SERVICE_UNAVAILABLE';

/** Throw this from services for expected business errors. */
export class AppException extends HttpException {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    status: HttpStatus,
    public readonly details?: unknown,
  ) {
    super({ code, message, details }, status);
  }
}
