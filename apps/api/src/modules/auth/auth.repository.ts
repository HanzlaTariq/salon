import { Injectable } from '@nestjs/common';
import { UserRole, UserStatus } from '../../common/auth/roles';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditEntry, SqlClient, insertAudit } from '../audit/audit.types';

export interface UserRecord {
  id: string;
  email: string;
  phone: string | null;
  passwordHash: string;
  fullName: string;
  role: UserRole;
  status: UserStatus;
  emailVerifiedAt: Date | null;
  failedLoginCount: number;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  passwordChangedAt: Date | null;
  mfaSecretEnc: string | null;
  mfaEnabledAt: Date | null;
  mfaLastStep: number | null;
  createdAt: Date;
}

export interface SessionRecord {
  id: string;
  userId: string;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  userAgent: string | null;
  ipAddress: string | null;
  mfaVerified: boolean;
}

export type AuthTokenType = 'EMAIL_VERIFICATION' | 'PASSWORD_RESET';
export type RefreshOutcome =
  | { outcome: 'ok'; sessionId: string; userId: string }
  | { outcome: 'reused'; sessionId: string; userId: string }
  | { outcome: 'invalid' };

interface UserRow {
  id: string;
  email: string;
  phone: string | null;
  password_hash: string;
  full_name: string;
  role: UserRole;
  status: UserStatus;
  email_verified_at: Date | null;
  failed_login_count: number;
  locked_until: Date | null;
  last_login_at: Date | null;
  password_changed_at: Date | null;
  mfa_secret_enc: string | null;
  mfa_enabled_at: Date | null;
  mfa_last_step: number | null;
  created_at: Date;
}

interface SessionRow {
  id: string;
  user_id: string;
  created_at: Date;
  last_used_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  user_agent: string | null;
  ip_address: string | null;
  mfa_verified: boolean;
}

const toUser = (r: UserRow): UserRecord => ({
  id: r.id,
  email: r.email,
  phone: r.phone,
  passwordHash: r.password_hash,
  fullName: r.full_name,
  role: r.role,
  status: r.status,
  emailVerifiedAt: r.email_verified_at,
  failedLoginCount: r.failed_login_count,
  lockedUntil: r.locked_until,
  lastLoginAt: r.last_login_at,
  passwordChangedAt: r.password_changed_at,
  mfaSecretEnc: r.mfa_secret_enc,
  mfaEnabledAt: r.mfa_enabled_at,
  mfaLastStep: r.mfa_last_step,
  createdAt: r.created_at,
});

const toSession = (r: SessionRow): SessionRecord => ({
  id: r.id,
  userId: r.user_id,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  expiresAt: r.expires_at,
  revokedAt: r.revoked_at,
  userAgent: r.user_agent,
  ipAddress: r.ip_address,
  mfaVerified: r.mfa_verified,
});

/**
 * All SQL for identity data. Every value is a bound parameter (tagged templates), with explicit
 * casts so PostgreSQL never has to guess parameter types. Single-use semantics (refresh tokens,
 * e-mail/reset tokens, recovery codes, TOTP steps) are enforced by ONE atomic UPDATE ... WHERE
 * ... RETURNING, so concurrent requests can never both succeed.
 */
@Injectable()
export class AuthRepository {
  private readonly db: SqlClient;

  constructor(prisma: PrismaService) {
    this.db = prisma as unknown as SqlClient;
  }

  // ---------- users ----------

  /** Returns null when the e-mail is already registered (no exception-based control flow). */
  async createUser(i: {
    email: string;
    phone: string | null;
    passwordHash: string;
    fullName: string;
    role: UserRole;
    status?: UserStatus;
    emailVerifiedAt?: Date | null;
  }): Promise<UserRecord | null> {
    const rows = await this.db.$queryRaw<UserRow[]>`
      INSERT INTO users (email, phone, password_hash, full_name, role, status, email_verified_at)
      VALUES (${i.email}::varchar, ${i.phone}::varchar, ${i.passwordHash}::varchar, ${i.fullName}::varchar,
              ${i.role}::user_role, ${i.status ?? 'PENDING_VERIFICATION'}::user_status, ${i.emailVerifiedAt ?? null}::timestamptz)
      ON CONFLICT (email) DO NOTHING
      RETURNING *`;
    return rows[0] ? toUser(rows[0]) : null;
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const rows = await this.db.$queryRaw<UserRow[]>`SELECT * FROM users WHERE email = ${email}::varchar`;
    return rows[0] ? toUser(rows[0]) : null;
  }

  async findUserById(id: string): Promise<UserRecord | null> {
    const rows = await this.db.$queryRaw<UserRow[]>`SELECT * FROM users WHERE id = ${id}::uuid`;
    return rows[0] ? toUser(rows[0]) : null;
  }

  async listUsers(f: {
    role?: UserRole;
    status?: UserStatus;
    q?: string;
    limit: number;
    offset: number;
  }): Promise<{ items: UserRecord[]; total: number }> {
    const like = f.q ? `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const rows = await this.db.$queryRaw<UserRow[]>`
      SELECT * FROM users
      WHERE (${f.role ?? null}::user_role IS NULL OR role = ${f.role ?? null}::user_role)
        AND (${f.status ?? null}::user_status IS NULL OR status = ${f.status ?? null}::user_status)
        AND (${like}::varchar IS NULL OR email ILIKE ${like}::varchar OR full_name ILIKE ${like}::varchar)
      ORDER BY created_at DESC, id DESC
      LIMIT ${f.limit}::int OFFSET ${f.offset}::int`;
    const count = await this.db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM users
      WHERE (${f.role ?? null}::user_role IS NULL OR role = ${f.role ?? null}::user_role)
        AND (${f.status ?? null}::user_status IS NULL OR status = ${f.status ?? null}::user_status)
        AND (${like}::varchar IS NULL OR email ILIKE ${like}::varchar OR full_name ILIKE ${like}::varchar)`;
    return { items: rows.map(toUser), total: count[0]?.n ?? 0 };
  }

  /** Verifies e-mail; activates the account only if it was waiting for verification (never un-suspends). */
  async markEmailVerified(userId: string, now: Date): Promise<void> {
    await this.db.$executeRaw`
      UPDATE users SET
        email_verified_at = COALESCE(email_verified_at, ${now}::timestamptz),
        status = CASE WHEN status = 'PENDING_VERIFICATION' THEN 'ACTIVE'::user_status ELSE status END,
        updated_at = ${now}::timestamptz
      WHERE id = ${userId}::uuid`;
  }

  /**
   * Atomically counts a failed attempt; when the limit is reached the account locks and the counter
   * resets. Returns the lock expiry if the account is now locked.
   */
  async registerFailedLogin(userId: string, maxAttempts: number, lockUntil: Date, now: Date): Promise<Date | null> {
    const rows = await this.db.$queryRaw<{ locked_until: Date | null }[]>`
      UPDATE users SET
        failed_login_count = CASE WHEN failed_login_count + 1 >= ${maxAttempts}::int THEN 0 ELSE failed_login_count + 1 END,
        locked_until = CASE WHEN failed_login_count + 1 >= ${maxAttempts}::int THEN ${lockUntil}::timestamptz ELSE locked_until END,
        updated_at = ${now}::timestamptz
      WHERE id = ${userId}::uuid
      RETURNING locked_until`;
    const lockedUntil = rows[0]?.locked_until ?? null;
    return lockedUntil && lockedUntil > now ? lockedUntil : null;
  }

  async recordSuccessfulLogin(userId: string, now: Date): Promise<void> {
    await this.db.$executeRaw`
      UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = ${now}::timestamptz,
                       updated_at = ${now}::timestamptz
      WHERE id = ${userId}::uuid`;
  }

  async setPassword(userId: string, passwordHash: string, now: Date): Promise<void> {
    await this.db.$executeRaw`
      UPDATE users SET password_hash = ${passwordHash}::varchar, password_changed_at = ${now}::timestamptz,
                       failed_login_count = 0, locked_until = NULL, updated_at = ${now}::timestamptz
      WHERE id = ${userId}::uuid`;
  }

  /** Status change + audit record in ONE transaction. Returns false if the user no longer exists. */
  async setUserStatus(userId: string, status: UserStatus, audit: AuditEntry, now: Date): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      const n = await tx.$executeRaw`
        UPDATE users SET status = ${status}::user_status, updated_at = ${now}::timestamptz WHERE id = ${userId}::uuid`;
      if (n === 0) return false;
      await insertAudit(tx, audit);
      return true;
    });
  }

  // ---------- sessions & refresh tokens ----------

  async createSession(i: {
    userId: string;
    expiresAt: Date;
    ip: string | null;
    userAgent: string | null;
    mfaVerified: boolean;
    refreshHash: string;
    refreshExpiresAt: Date;
  }): Promise<SessionRecord> {
    return this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<SessionRow[]>`
        INSERT INTO auth_sessions (user_id, expires_at, ip_address, user_agent, mfa_verified)
        VALUES (${i.userId}::uuid, ${i.expiresAt}::timestamptz, ${i.ip}::varchar, ${i.userAgent}::varchar, ${i.mfaVerified}::boolean)
        RETURNING *`;
      await tx.$executeRaw`
        INSERT INTO refresh_tokens (session_id, token_hash, expires_at)
        VALUES (${rows[0].id}::uuid, ${i.refreshHash}::varchar, ${i.refreshExpiresAt}::timestamptz)`;
      return toSession(rows[0]);
    });
  }

  /**
   * Single-use rotation primitive. The UPDATE succeeds for exactly one caller; anyone presenting an
   * already-used token is a REUSE (theft signal) and the caller revokes the whole session.
   */
  async consumeRefreshToken(tokenHash: string, now: Date): Promise<RefreshOutcome> {
    const used = await this.db.$queryRaw<{ session_id: string }[]>`
      UPDATE refresh_tokens SET used_at = ${now}::timestamptz
      WHERE token_hash = ${tokenHash}::varchar AND used_at IS NULL AND expires_at > ${now}::timestamptz
      RETURNING session_id`;
    if (used[0]) {
      const s = await this.db.$queryRaw<{ user_id: string }[]>`SELECT user_id FROM auth_sessions WHERE id = ${used[0].session_id}::uuid`;
      return s[0] ? { outcome: 'ok', sessionId: used[0].session_id, userId: s[0].user_id } : { outcome: 'invalid' };
    }
    const prior = await this.db.$queryRaw<{ session_id: string; user_id: string; used_at: Date | null }[]>`
      SELECT r.session_id, s.user_id, r.used_at FROM refresh_tokens r
      JOIN auth_sessions s ON s.id = r.session_id
      WHERE r.token_hash = ${tokenHash}::varchar`;
    if (prior[0]?.used_at) return { outcome: 'reused', sessionId: prior[0].session_id, userId: prior[0].user_id };
    return { outcome: 'invalid' };
  }

  async addRefreshToken(sessionId: string, tokenHash: string, expiresAt: Date, now: Date): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO refresh_tokens (session_id, token_hash, expires_at)
        VALUES (${sessionId}::uuid, ${tokenHash}::varchar, ${expiresAt}::timestamptz)`;
      await tx.$executeRaw`UPDATE auth_sessions SET last_used_at = ${now}::timestamptz WHERE id = ${sessionId}::uuid`;
    });
  }

  /** Session + owner for per-request validation. Null when revoked, expired or missing. */
  async findActiveSession(sessionId: string, now: Date): Promise<{ session: SessionRecord; user: UserRecord } | null> {
    const rows = await this.db.$queryRaw<(SessionRow & { u: never })[]>`
      SELECT s.* FROM auth_sessions s
      WHERE s.id = ${sessionId}::uuid AND s.revoked_at IS NULL AND s.expires_at > ${now}::timestamptz`;
    if (!rows[0]) return null;
    const user = await this.findUserById(rows[0].user_id);
    return user ? { session: toSession(rows[0]), user } : null;
  }

  async findSessionByRefreshHash(tokenHash: string): Promise<{ sessionId: string; userId: string } | null> {
    const rows = await this.db.$queryRaw<{ session_id: string; user_id: string }[]>`
      SELECT r.session_id, s.user_id FROM refresh_tokens r JOIN auth_sessions s ON s.id = r.session_id
      WHERE r.token_hash = ${tokenHash}::varchar`;
    return rows[0] ? { sessionId: rows[0].session_id, userId: rows[0].user_id } : null;
  }

  async revokeSession(sessionId: string, reason: string, now: Date, userId?: string): Promise<boolean> {
    const n = await this.db.$executeRaw`
      UPDATE auth_sessions SET revoked_at = ${now}::timestamptz, revoked_reason = ${reason}::varchar
      WHERE id = ${sessionId}::uuid AND revoked_at IS NULL
        AND (${userId ?? null}::uuid IS NULL OR user_id = ${userId ?? null}::uuid)`;
    return n > 0;
  }

  async revokeAllSessions(userId: string, reason: string, now: Date, exceptSessionId?: string): Promise<number> {
    return this.db.$executeRaw`
      UPDATE auth_sessions SET revoked_at = ${now}::timestamptz, revoked_reason = ${reason}::varchar
      WHERE user_id = ${userId}::uuid AND revoked_at IS NULL
        AND (${exceptSessionId ?? null}::uuid IS NULL OR id <> ${exceptSessionId ?? null}::uuid)`;
  }

  async listActiveSessions(userId: string, now: Date): Promise<SessionRecord[]> {
    const rows = await this.db.$queryRaw<SessionRow[]>`
      SELECT * FROM auth_sessions
      WHERE user_id = ${userId}::uuid AND revoked_at IS NULL AND expires_at > ${now}::timestamptz
      ORDER BY last_used_at DESC`;
    return rows.map(toSession);
  }

  /** Housekeeping: delete dead sessions (cascades to their refresh tokens) and spent/expired one-time tokens. */
  async purgeExpired(before: Date): Promise<{ sessions: number; tokens: number }> {
    const sessions = await this.db.$executeRaw`
      DELETE FROM auth_sessions WHERE expires_at < ${before}::timestamptz OR revoked_at < ${before}::timestamptz`;
    const tokens = await this.db.$executeRaw`
      DELETE FROM auth_tokens WHERE expires_at < ${before}::timestamptz OR used_at < ${before}::timestamptz`;
    return { sessions, tokens };
  }

  // ---------- one-time tokens (e-mail verification, password reset) ----------

  /** Issuing a new token invalidates earlier unused tokens of the same type for that user. */
  async createAuthToken(userId: string, type: AuthTokenType, tokenHash: string, expiresAt: Date, now: Date): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE auth_tokens SET used_at = ${now}::timestamptz
        WHERE user_id = ${userId}::uuid AND type = ${type}::auth_token_type AND used_at IS NULL`;
      await tx.$executeRaw`
        INSERT INTO auth_tokens (user_id, type, token_hash, expires_at)
        VALUES (${userId}::uuid, ${type}::auth_token_type, ${tokenHash}::varchar, ${expiresAt}::timestamptz)`;
    });
  }

  /** Atomic single-use consume. Returns the owning user id, or null if unknown / used / expired. */
  async consumeAuthToken(tokenHash: string, type: AuthTokenType, now: Date): Promise<string | null> {
    const rows = await this.db.$queryRaw<{ user_id: string }[]>`
      UPDATE auth_tokens SET used_at = ${now}::timestamptz
      WHERE token_hash = ${tokenHash}::varchar AND type = ${type}::auth_token_type
        AND used_at IS NULL AND expires_at > ${now}::timestamptz
      RETURNING user_id`;
    return rows[0]?.user_id ?? null;
  }

  async latestAuthTokenCreatedAt(userId: string, type: AuthTokenType): Promise<Date | null> {
    const rows = await this.db.$queryRaw<{ created_at: Date }[]>`
      SELECT created_at FROM auth_tokens WHERE user_id = ${userId}::uuid AND type = ${type}::auth_token_type
      ORDER BY created_at DESC LIMIT 1`;
    return rows[0]?.created_at ?? null;
  }


  /** Read-only check used to validate a new password BEFORE the single-use token is spent. */
  async peekAuthToken(tokenHash: string, type: AuthTokenType, now: Date): Promise<string | null> {
    const rows = await this.db.$queryRaw<{ user_id: string }[]>`
      SELECT user_id FROM auth_tokens
      WHERE token_hash = ${tokenHash}::varchar AND type = ${type}::auth_token_type
        AND used_at IS NULL AND expires_at > ${now}::timestamptz`;
    return rows[0]?.user_id ?? null;
  }

  async setSessionMfaVerified(sessionId: string): Promise<void> {
    await this.db.$executeRaw`UPDATE auth_sessions SET mfa_verified = true WHERE id = ${sessionId}::uuid`;
  }

  // ---------- MFA ----------

  async setPendingMfaSecret(userId: string, secretEnc: string, now: Date): Promise<void> {
    await this.db.$executeRaw`
      UPDATE users SET mfa_secret_enc = ${secretEnc}::varchar, mfa_enabled_at = NULL, mfa_last_step = NULL,
                       updated_at = ${now}::timestamptz
      WHERE id = ${userId}::uuid AND mfa_enabled_at IS NULL`;
  }

  /** Atomically confirms enrolment and replaces recovery codes. False if already enabled / no pending secret. */
  async enableMfa(userId: string, step: number, recoveryHashes: string[], now: Date): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      const n = await tx.$executeRaw`
        UPDATE users SET mfa_enabled_at = ${now}::timestamptz, mfa_last_step = ${step}::int, updated_at = ${now}::timestamptz
        WHERE id = ${userId}::uuid AND mfa_enabled_at IS NULL AND mfa_secret_enc IS NOT NULL`;
      if (n === 0) return false;
      await tx.$executeRaw`DELETE FROM mfa_recovery_codes WHERE user_id = ${userId}::uuid`;
      for (const h of recoveryHashes) {
        await tx.$executeRaw`INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES (${userId}::uuid, ${h}::varchar)`;
      }
      return true;
    });
  }

  async disableMfa(userId: string, now: Date): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE users SET mfa_secret_enc = NULL, mfa_enabled_at = NULL, mfa_last_step = NULL, updated_at = ${now}::timestamptz
        WHERE id = ${userId}::uuid`;
      await tx.$executeRaw`DELETE FROM mfa_recovery_codes WHERE user_id = ${userId}::uuid`;
    });
  }

  /** Accepts a TOTP step only if it is newer than every step accepted before (atomic replay guard). */
  async advanceMfaStep(userId: string, step: number): Promise<boolean> {
    const n = await this.db.$executeRaw`
      UPDATE users SET mfa_last_step = ${step}::int
      WHERE id = ${userId}::uuid AND (mfa_last_step IS NULL OR mfa_last_step < ${step}::int)`;
    return n > 0;
  }

  async consumeRecoveryCode(userId: string, codeHash: string, now: Date): Promise<boolean> {
    const n = await this.db.$executeRaw`
      UPDATE mfa_recovery_codes SET used_at = ${now}::timestamptz
      WHERE user_id = ${userId}::uuid AND code_hash = ${codeHash}::varchar AND used_at IS NULL`;
    return n > 0;
  }

  async countUnusedRecoveryCodes(userId: string): Promise<number> {
    const rows = await this.db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM mfa_recovery_codes WHERE user_id = ${userId}::uuid AND used_at IS NULL`;
    return rows[0]?.n ?? 0;
  }
}
