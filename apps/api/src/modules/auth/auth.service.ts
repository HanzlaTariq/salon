import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { AuthenticatedUser } from '../../common/auth/authenticated-user';
import { isPlatformRole } from '../../common/auth/roles';
import { AppException } from '../../common/errors/app-exception';
import { ClientContext } from '../../common/http/client-context';
import { Clock } from '../../common/util/clock';
import { normalizePhone } from '../../common/util/phone';
import { ENV, Env } from '../../config/env';
import { AuditService } from '../audit/audit.service';
import { AuthRepository, SessionRecord, UserRecord } from './auth.repository';
import { AuthResult, PublicUser } from './auth.types';
import { ChangePasswordDto, LoginDto, RegisterDto } from './dto/auth.dto';
import { MailService } from './mail/mail.service';
import { MfaCrypto } from './mfa-crypto';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { checkPasswordBreach } from './breach-check';
import { generateTotpSecret, otpauthUri, verifyTotp } from './totp';

const MS_DAY = 86_400_000;
const VERIFY_TOKEN_TTL_MS = 24 * 3_600_000;
const RESET_TOKEN_TTL_MS = 30 * 60_000;
const RESEND_COOLDOWN_MS = 60_000;
const RECOVERY_CODE_COUNT = 10;
const ISSUER = 'Salon Platform';
const RECOVERY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const invalidCredentials = () =>
  new AppException('INVALID_CREDENTIALS', 'Invalid credentials, or the account is temporarily locked.', 401);

export function toPublicUser(u: UserRecord): PublicUser {
  return {
    id: u.id,
    email: u.email,
    fullName: u.fullName,
    phone: u.phone,
    role: u.role,
    status: u.status,
    emailVerified: u.emailVerifiedAt !== null,
    mfaEnabled: u.mfaEnabledAt !== null,
  };
}

function newRecoveryCode(): string {
  const bytes = randomBytes(16);
  let raw = '';
  for (const b of bytes) raw += RECOVERY_ALPHABET[b % 32]; // 32 divides 256: no modulo bias
  return raw.match(/.{4}/g)!.join('-');
}

function normalizeRecoveryCode(input: string): string | null {
  const c = input.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-Z2-7]{16}$/.test(c) ? c : null;
}

const hashRecovery = (userId: string, code: string) => createHash('sha256').update(`recovery:${userId}:${code}`).digest('hex');

@Injectable()
export class AuthService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly repo: AuthRepository,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly mfaCrypto: MfaCrypto,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  // ------------------------------------------------------------------ registration & e-mail

  /**
   * Always resolves the same way whether or not the e-mail is already registered (no account
   * enumeration). Hashing happens before the lookup so both branches cost the same.
   */
  async register(dto: RegisterDto, ctx: ClientContext): Promise<void> {
    const phone = dto.phone ? normalizePhone(dto.phone) : null;
    if (dto.phone && !phone) {
      throw new AppException('VALIDATION_FAILED', 'Request validation failed.', 400, ['phone is not a valid phone number']);
    }
    this.assertPasswordPolicy(dto.password, { email: dto.email, fullName: dto.fullName });
    await this.assertNotBreached(dto.password);

    const passwordHash = await this.passwords.hash(dto.password);
    const user = await this.repo.createUser({
      email: dto.email,
      phone,
      passwordHash,
      fullName: dto.fullName,
      role: dto.accountType, // allowlisted by the DTO; privileged roles can never be self-assigned
    });

    if (!user) {
      const existing = await this.repo.findUserByEmail(dto.email);
      if (existing) await this.mail.sendAccountExists(existing.email, existing.fullName);
      await this.audit.recordSafe({ action: 'auth.register_duplicate', ...this.ctxFields(ctx) });
      return;
    }
    await this.issueEmailVerification(user);
    await this.audit.recordSafe({
      actorUserId: user.id,
      actorRole: user.role,
      action: 'auth.register',
      targetType: 'user',
      targetId: user.id,
      ...this.ctxFields(ctx),
    });
  }

  async verifyEmail(token: string, ctx: ClientContext): Promise<void> {
    const userId = await this.repo.consumeAuthToken(TokenService.hash(token), 'EMAIL_VERIFICATION', this.clock.now());
    if (!userId) throw new AppException('TOKEN_INVALID', 'This link is invalid or has expired.', 400);
    await this.repo.markEmailVerified(userId, this.clock.now());
    await this.audit.recordSafe({ actorUserId: userId, action: 'auth.email_verified', targetType: 'user', targetId: userId, ...this.ctxFields(ctx) });
  }

  async resendVerification(email: string): Promise<void> {
    const user = await this.repo.findUserByEmail(email);
    if (!user || user.status !== 'PENDING_VERIFICATION') return;
    if (await this.inCooldown(user.id, 'EMAIL_VERIFICATION')) return;
    await this.issueEmailVerification(user);
  }

  // ------------------------------------------------------------------ login / refresh / logout

  async login(dto: LoginDto, ctx: ClientContext): Promise<AuthResult> {
    const now = this.clock.now();
    const user = await this.repo.findUserByEmail(dto.email);

    if (!user) {
      await this.passwords.verifyDummy(dto.password);
      await this.audit.recordSafe({ action: 'auth.login_failed', metadata: { reason: 'unknown_user' }, ...this.ctxFields(ctx) });
      throw invalidCredentials();
    }
    if (user.lockedUntil && user.lockedUntil > now) {
      await this.passwords.verifyDummy(dto.password); // no oracle, no timing difference
      await this.audit.recordSafe({ actorUserId: user.id, action: 'auth.login_failed', metadata: { reason: 'locked' }, ...this.ctxFields(ctx) });
      throw invalidCredentials();
    }
    if (!(await this.passwords.verify(user.passwordHash, dto.password))) {
      await this.failLogin(user, 'bad_password', ctx);
      throw invalidCredentials();
    }

    // The password is correct, so revealing account state to its rightful owner is safe.
    if (user.status === 'SUSPENDED') {
      await this.audit.recordSafe({ actorUserId: user.id, action: 'auth.login_blocked', metadata: { reason: 'suspended' }, ...this.ctxFields(ctx) });
      throw new AppException('ACCOUNT_SUSPENDED', 'This account has been suspended. Contact support.', 403);
    }
    if (user.status === 'PENDING_VERIFICATION') {
      throw new AppException('EMAIL_NOT_VERIFIED', 'Please verify your e-mail address before signing in.', 403);
    }

    let mfaVerified = false;
    if (user.mfaEnabledAt) {
      if (!dto.mfaCode) throw new AppException('MFA_REQUIRED', 'A verification code is required.', 401);
      if (!(await this.verifySecondFactor(user, dto.mfaCode))) {
        await this.failLogin(user, 'bad_mfa', ctx);
        throw invalidCredentials();
      }
      mfaVerified = true;
    }

    await this.repo.recordSuccessfulLogin(user.id, now);
    const result = await this.issueSession(user, ctx, mfaVerified);
    await this.audit.recordSafe({ actorUserId: user.id, actorRole: user.role, action: 'auth.login', targetType: 'user', targetId: user.id, ...this.ctxFields(ctx) });
    return result;
  }

  async refresh(rawToken: string, ctx: ClientContext): Promise<AuthResult> {
    const now = this.clock.now();
    const r = await this.repo.consumeRefreshToken(TokenService.hash(rawToken), now);
    if (r.outcome === 'reused') {
      // A rotated token came back: it was copied. Kill the whole session so neither party keeps access.
      await this.repo.revokeSession(r.sessionId, 'REUSE_DETECTED', now);
      await this.audit.recordSafe({ actorUserId: r.userId, action: 'auth.refresh_reuse_detected', targetType: 'session', targetId: r.sessionId, ...this.ctxFields(ctx) });
      throw new AppException('TOKEN_INVALID', 'Session is no longer valid. Please sign in again.', 401);
    }
    // Parallel request with the same token: the winner keeps the session, this one is simply refused.
    if (r.outcome === 'concurrent') throw new AppException('UNAUTHENTICATED', 'Session is no longer valid. Please sign in again.', 401);
    if (r.outcome === 'invalid') throw new AppException('UNAUTHENTICATED', 'Session is no longer valid. Please sign in again.', 401);

    const active = await this.repo.findActiveSession(r.sessionId, now);
    if (!active || active.user.status !== 'ACTIVE') {
      throw new AppException('UNAUTHENTICATED', 'Session is no longer valid. Please sign in again.', 401);
    }
    const next = this.tokens.newOpaqueToken();
    const expiresAt = this.refreshExpiry(now, active.session);
    await this.repo.addRefreshToken(active.session.id, next.hash, expiresAt, now);
    const access = await this.tokens.signAccessToken({ userId: active.user.id, sessionId: active.session.id });
    return {
      accessToken: access.token,
      expiresIn: access.expiresInSec,
      refreshToken: next.raw,
      user: toPublicUser(active.user),
      mfaEnrollmentRequired: this.mfaEnrollmentRequired(active.user),
    };
  }

  /** Idempotent: always succeeds. Works from the refresh token alone so an expired access token can still log out. */
  async logout(rawRefreshToken: string | null, sessionIdFromAccess: string | null, ctx: ClientContext): Promise<void> {
    const now = this.clock.now();
    let sessionId = sessionIdFromAccess;
    let userId: string | undefined;
    if (rawRefreshToken) {
      const found = await this.repo.findSessionByRefreshHash(TokenService.hash(rawRefreshToken));
      if (found) {
        sessionId = found.sessionId;
        userId = found.userId;
      }
    }
    if (sessionId && (await this.repo.revokeSession(sessionId, 'LOGOUT', now))) {
      await this.audit.recordSafe({ actorUserId: userId ?? null, action: 'auth.logout', targetType: 'session', targetId: sessionId, ...this.ctxFields(ctx) });
    }
  }

  async logoutAll(user: AuthenticatedUser, keepCurrent: boolean, ctx: ClientContext): Promise<number> {
    const n = await this.repo.revokeAllSessions(user.id, 'LOGOUT_ALL', this.clock.now(), keepCurrent ? user.sessionId : undefined);
    await this.audit.recordSafe({ actorUserId: user.id, actorRole: user.role, action: 'auth.logout_all', targetType: 'user', targetId: user.id, metadata: { revoked: n }, ...this.ctxFields(ctx) });
    return n;
  }

  async listSessions(user: AuthenticatedUser) {
    const sessions = await this.repo.listActiveSessions(user.id, this.clock.now());
    return sessions.map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
      userAgent: s.userAgent,
      ipAddress: s.ipAddress,
      current: s.id === user.sessionId,
    }));
  }

  /** Scoped to the caller's own user id: another user's session id simply returns 404 (no IDOR). */
  async revokeOwnSession(user: AuthenticatedUser, sessionId: string, ctx: ClientContext): Promise<void> {
    const ok = await this.repo.revokeSession(sessionId, 'USER_REVOKED', this.clock.now(), user.id);
    if (!ok) throw new AppException('NOT_FOUND', 'Session not found.', 404);
    await this.audit.recordSafe({ actorUserId: user.id, action: 'auth.session_revoked', targetType: 'session', targetId: sessionId, ...this.ctxFields(ctx) });
  }

  // ------------------------------------------------------------------ passwords

  /** Same response for known and unknown addresses. */
  async forgotPassword(email: string, ctx: ClientContext): Promise<void> {
    const user = await this.repo.findUserByEmail(email);
    if (!user || user.status === 'SUSPENDED') return;
    if (await this.inCooldown(user.id, 'PASSWORD_RESET')) return;
    const t = this.tokens.newOpaqueToken();
    const now = this.clock.now();
    await this.repo.createAuthToken(user.id, 'PASSWORD_RESET', t.hash, new Date(now.getTime() + RESET_TOKEN_TTL_MS), now);
    await this.mail.sendPasswordReset(user.email, user.fullName, t.raw);
    await this.audit.recordSafe({ actorUserId: user.id, action: 'auth.password_reset_requested', targetType: 'user', targetId: user.id, ...this.ctxFields(ctx) });
  }

  async resetPassword(token: string, newPassword: string, ctx: ClientContext): Promise<void> {
    const now = this.clock.now();
    const hash = TokenService.hash(token);
    const peekedUserId = await this.repo.peekAuthToken(hash, 'PASSWORD_RESET', now);
    if (!peekedUserId) throw new AppException('TOKEN_INVALID', 'This link is invalid or has expired.', 400);
    const user = await this.repo.findUserById(peekedUserId);
    if (!user) throw new AppException('TOKEN_INVALID', 'This link is invalid or has expired.', 400);

    // Validate BEFORE spending the single-use token so a weak password does not burn the link.
    this.assertPasswordPolicy(newPassword, { email: user.email, fullName: user.fullName });
    await this.assertNotBreached(newPassword);

    const userId = await this.repo.consumeAuthToken(hash, 'PASSWORD_RESET', now);
    if (!userId || userId !== user.id) throw new AppException('TOKEN_INVALID', 'This link is invalid or has expired.', 400);

    await this.repo.setPassword(user.id, await this.passwords.hash(newPassword), now);
    await this.repo.markEmailVerified(user.id, now); // proves control of the mailbox
    await this.repo.revokeAllSessions(user.id, 'PASSWORD_RESET', now);
    await this.mail.sendPasswordChanged(user.email, user.fullName);
    await this.audit.recordSafe({ actorUserId: user.id, actorRole: user.role, action: 'auth.password_reset', targetType: 'user', targetId: user.id, ...this.ctxFields(ctx) });
  }

  async changePassword(actor: AuthenticatedUser, dto: ChangePasswordDto, ctx: ClientContext): Promise<void> {
    const user = await this.mustFindUser(actor.id);
    if (!(await this.passwords.verify(user.passwordHash, dto.currentPassword))) {
      throw new AppException('INVALID_CREDENTIALS', 'Current password is incorrect.', 400);
    }
    if (dto.newPassword === dto.currentPassword) {
      throw new AppException('VALIDATION_FAILED', 'Request validation failed.', 400, ['New password must differ from the current one.']);
    }
    this.assertPasswordPolicy(dto.newPassword, { email: user.email, fullName: user.fullName });
    await this.assertNotBreached(dto.newPassword);
    const now = this.clock.now();
    await this.repo.setPassword(user.id, await this.passwords.hash(dto.newPassword), now);
    await this.repo.revokeAllSessions(user.id, 'PASSWORD_CHANGED', now, actor.sessionId);
    await this.mail.sendPasswordChanged(user.email, user.fullName);
    await this.audit.recordSafe({ actorUserId: user.id, actorRole: user.role, action: 'auth.password_changed', targetType: 'user', targetId: user.id, ...this.ctxFields(ctx) });
  }

  // ------------------------------------------------------------------ MFA

  async mfaSetup(actor: AuthenticatedUser, password: string): Promise<{ secret: string; otpauthUri: string }> {
    const user = await this.mustFindUser(actor.id);
    if (!(await this.passwords.verify(user.passwordHash, password))) {
      throw new AppException('INVALID_CREDENTIALS', 'Password is incorrect.', 400);
    }
    if (user.mfaEnabledAt) throw new AppException('CONFLICT', 'Two-factor authentication is already enabled.', 409);
    const secret = generateTotpSecret();
    await this.repo.setPendingMfaSecret(user.id, this.mfaCrypto.encrypt(secret, user.id), this.clock.now());
    return { secret, otpauthUri: otpauthUri(ISSUER, user.email, secret) };
  }

  async mfaEnable(actor: AuthenticatedUser, code: string, ctx: ClientContext): Promise<{ recoveryCodes: string[] }> {
    const user = await this.mustFindUser(actor.id);
    if (user.mfaEnabledAt) throw new AppException('CONFLICT', 'Two-factor authentication is already enabled.', 409);
    if (!user.mfaSecretEnc) throw new AppException('VALIDATION_FAILED', 'Start setup first.', 400);
    const secret = this.mfaCrypto.decrypt(user.mfaSecretEnc, user.id);
    const step = verifyTotp(secret, code, this.clock.now().getTime(), null);
    if (step === null) throw new AppException('INVALID_CREDENTIALS', 'That code is not valid.', 400);

    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    const hashes = codes.map((c) => hashRecovery(user.id, normalizeRecoveryCode(c)!));
    if (!(await this.repo.enableMfa(user.id, step, hashes, this.clock.now()))) {
      throw new AppException('CONFLICT', 'Two-factor authentication is already enabled.', 409);
    }
    await this.repo.setSessionMfaVerified(actor.sessionId);
    await this.repo.revokeAllSessions(user.id, 'MFA_ENABLED', this.clock.now(), actor.sessionId);
    await this.audit.recordSafe({ actorUserId: user.id, actorRole: user.role, action: 'auth.mfa_enabled', targetType: 'user', targetId: user.id, ...this.ctxFields(ctx) });
    return { recoveryCodes: codes }; // shown exactly once; only hashes are stored
  }

  async mfaDisable(actor: AuthenticatedUser, password: string, code: string, ctx: ClientContext): Promise<void> {
    if (isPlatformRole(actor.role) && this.env.REQUIRE_ADMIN_MFA) {
      throw new AppException('FORBIDDEN', 'Two-factor authentication is mandatory for this account.', 403);
    }
    const user = await this.mustFindUser(actor.id);
    if (!user.mfaEnabledAt) throw new AppException('CONFLICT', 'Two-factor authentication is not enabled.', 409);
    if (!(await this.passwords.verify(user.passwordHash, password)) || !(await this.verifySecondFactor(user, code))) {
      throw new AppException('INVALID_CREDENTIALS', 'Password or code is incorrect.', 400);
    }
    const now = this.clock.now();
    await this.repo.disableMfa(user.id, now);
    await this.repo.revokeAllSessions(user.id, 'MFA_DISABLED', now, actor.sessionId);
    await this.audit.recordSafe({ actorUserId: user.id, actorRole: user.role, action: 'auth.mfa_disabled', targetType: 'user', targetId: user.id, ...this.ctxFields(ctx) });
  }

  async me(actor: AuthenticatedUser): Promise<{ user: PublicUser; mfaEnrollmentRequired: boolean }> {
    return { user: toPublicUser(await this.mustFindUser(actor.id)), mfaEnrollmentRequired: actor.mfaEnrollmentRequired };
  }

  // ------------------------------------------------------------------ helpers

  mfaEnrollmentRequired(u: Pick<UserRecord, 'role' | 'mfaEnabledAt'>): boolean {
    return this.env.REQUIRE_ADMIN_MFA && isPlatformRole(u.role) && u.mfaEnabledAt === null;
  }

  private async mustFindUser(id: string): Promise<UserRecord> {
    const u = await this.repo.findUserById(id);
    if (!u) throw new AppException('UNAUTHENTICATED', 'Account not found.', 401);
    return u;
  }

  /**
   * Refuses passwords found in known breach corpora (k-anonymity: only a hash prefix is sent).
   * Runs after the local policy so an obviously weak password never costs an outbound call.
   */
  private async assertNotBreached(password: string): Promise<void> {
    if (!this.env.HIBP_CHECK_ENABLED) return;
    const result = await checkPasswordBreach(password);
    if (result === 'breached') {
      throw new AppException('VALIDATION_FAILED', 'Password does not meet requirements.', 400, [
        'This password appears in known data breaches. Please choose a different one.',
      ]);
    }
    if (result === 'unknown' && this.env.HIBP_FAIL_CLOSED) {
      throw new AppException('SERVICE_UNAVAILABLE', 'Password check is unavailable. Please try again shortly.', 503);
    }
  }

  private assertPasswordPolicy(password: string, ctx: { email: string; fullName: string }): void {
    const problems = this.passwords.policyProblems(password, ctx);
    if (problems.length > 0) throw new AppException('VALIDATION_FAILED', 'Password does not meet requirements.', 400, problems);
  }

  private ctxFields(ctx: ClientContext) {
    return { ipAddress: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId };
  }

  private async failLogin(user: UserRecord, reason: string, ctx: ClientContext): Promise<void> {
    const now = this.clock.now();
    const lockUntil = new Date(now.getTime() + this.env.LOGIN_LOCKOUT_MINUTES * 60_000);
    const locked = await this.repo.registerFailedLogin(user.id, this.env.LOGIN_MAX_ATTEMPTS, lockUntil, now);
    await this.audit.recordSafe({
      actorUserId: user.id,
      action: locked ? 'auth.account_locked' : 'auth.login_failed',
      targetType: 'user',
      targetId: user.id,
      metadata: { reason },
      ...this.ctxFields(ctx),
    });
  }

  private async inCooldown(userId: string, type: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET'): Promise<boolean> {
    const last = await this.repo.latestAuthTokenCreatedAt(userId, type);
    return last !== null && this.clock.now().getTime() - last.getTime() < RESEND_COOLDOWN_MS;
  }

  private async issueEmailVerification(user: UserRecord): Promise<void> {
    const t = this.tokens.newOpaqueToken();
    const now = this.clock.now();
    await this.repo.createAuthToken(user.id, 'EMAIL_VERIFICATION', t.hash, new Date(now.getTime() + VERIFY_TOKEN_TTL_MS), now);
    await this.mail.sendVerification(user.email, user.fullName, t.raw);
  }

  private refreshExpiry(now: Date, session: SessionRecord): Date {
    const byTtl = now.getTime() + this.env.REFRESH_TOKEN_TTL_DAYS * MS_DAY;
    return new Date(Math.min(byTtl, session.expiresAt.getTime()));
  }

  private async issueSession(user: UserRecord, ctx: ClientContext, mfaVerified: boolean): Promise<AuthResult> {
    const now = this.clock.now();
    const sessionExpires = new Date(now.getTime() + this.env.SESSION_MAX_DAYS * MS_DAY);
    const refresh = this.tokens.newOpaqueToken();
    const session = await this.repo.createSession({
      userId: user.id,
      expiresAt: sessionExpires,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      mfaVerified,
      refreshHash: refresh.hash,
      refreshExpiresAt: new Date(Math.min(now.getTime() + this.env.REFRESH_TOKEN_TTL_DAYS * MS_DAY, sessionExpires.getTime())),
    });
    const access = await this.tokens.signAccessToken({ userId: user.id, sessionId: session.id });
    return {
      accessToken: access.token,
      expiresIn: access.expiresInSec,
      refreshToken: refresh.raw,
      user: toPublicUser(user),
      mfaEnrollmentRequired: this.mfaEnrollmentRequired(user),
    };
  }

  /** TOTP (replay-protected) or one-time recovery code. */
  private async verifySecondFactor(user: UserRecord, code: string): Promise<boolean> {
    if (!user.mfaSecretEnc) return false;
    const trimmed = code.trim();
    if (/^\d{6}$/.test(trimmed)) {
      const secret = this.mfaCrypto.decrypt(user.mfaSecretEnc, user.id);
      const step = verifyTotp(secret, trimmed, this.clock.now().getTime(), user.mfaLastStep);
      return step !== null && (await this.repo.advanceMfaStep(user.id, step));
    }
    const recovery = normalizeRecoveryCode(trimmed);
    return recovery !== null && (await this.repo.consumeRecoveryCode(user.id, hashRecovery(user.id, recovery), this.clock.now()));
  }
}

