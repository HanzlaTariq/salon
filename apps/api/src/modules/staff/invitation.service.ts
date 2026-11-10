import { Inject, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';
import { ClientContext } from '../../common/http/client-context';
import { TenantDb, setTenantSalon } from '../../common/tenancy/tenant-db.service';
import { Clock } from '../../common/util/clock';
import { ENV, Env } from '../../config/env';
import { checkPasswordBreach } from '../auth/breach-check';
import { PasswordService } from '../auth/password.service';
import { TokenService } from '../auth/token.service';
import { insertAudit } from '../audit/audit.types';
import { SalonsRepository, Tx } from '../salons/salons.repository';
import { AcceptInvitationDto, PreviewInvitationDto } from './dto/staff.dto';
import { StaffRepository } from './staff.repository';
import { isExpired, maskEmail } from './staff.types';

const invalid = () => new AppException('TOKEN_INVALID', 'This invitation link is invalid or has expired.', 400);

/**
 * Public, token-based invitation flow. The token is a 256-bit random value; only its SHA-256 is stored, and
 * database access goes through `withInviteToken`, which exposes exactly one invitation row. Every failure
 * returns the same generic message, so the endpoints cannot be used to probe tokens or e-mail addresses.
 */
@Injectable()
export class InvitationService {
  constructor(
    private readonly tenant: TenantDb,
    private readonly repo: StaffRepository,
    private readonly salons: SalonsRepository,
    private readonly passwords: PasswordService,
    private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** What the accept screen shows before the person picks a password. */
  async preview(dto: PreviewInvitationDto) {
    const hash = TokenService.hash(dto.token);
    const now = this.clock.now();
    const out = await this.tenant.withInviteToken(hash, async (tx: Tx) => {
      const inv = await this.repo.findInvitationByTokenHash(tx, hash);
      if (!inv || inv.status !== 'PENDING' || isExpired(inv.expiresAt, now)) return null;
      await setTenantSalon(tx, inv.salonId);
      const [salon, profile] = await Promise.all([
        this.salons.findById(tx, inv.salonId),
        this.repo.findLiveProfileName(tx, inv.salonId, inv.staffId),
      ]);
      if (!salon || !profile || !profile.isActive || profile.userId) return null;
      return { salonName: salon.name, displayName: profile.displayName, email: maskEmail(inv.email), expiresAt: inv.expiresAt };
    });
    if (!out) throw invalid();
    return out;
  }

  /**
   * Creates the SALON_STAFF account (e-mail already verified by the invitation link) and links it to the
   * team profile, in ONE transaction that locks the invitation row. Replays and races fail cleanly.
   */
  async accept(dto: AcceptInvitationDto, meta: ClientContext) {
    const hash = TokenService.hash(dto.token);
    // 1) Read the invitation (no writes, no network calls inside the transaction).
    const facts = await this.tenant.withInviteToken(hash, async (tx: Tx) => {
      const inv = await this.repo.findInvitationByTokenHash(tx, hash);
      if (!inv || inv.status !== 'PENDING' || isExpired(inv.expiresAt, this.clock.now())) return null;
      await setTenantSalon(tx, inv.salonId);
      const salon = await this.salons.findById(tx, inv.salonId);
      return salon ? { email: inv.email, salonStatus: salon.status } : null;
    });
    if (!facts) throw invalid();
    if (facts.salonStatus !== 'APPROVED') throw new AppException('CONFLICT', 'The salon is not active yet. Try again later.', 409);

    // 2) Password rules (same policy as registration), then the hash. Outside the write transaction.
    const problems = this.passwords.policyProblems(dto.password, { email: facts.email, fullName: dto.fullName });
    if (problems.length > 0) throw new AppException('VALIDATION_FAILED', 'Password does not meet requirements.', 400, problems);
    await this.assertNotBreached(dto.password);
    const passwordHash = await this.passwords.hash(dto.password);

    // 3) Write: re-check the invitation under a row lock, create the account, link the profile, mark accepted.
    const now = this.clock.now();
    return this.tenant.withInviteToken(hash, async (tx: Tx) => {
      const inv = await this.repo.lockInvitationByTokenHash(tx, hash);
      if (!inv || inv.status !== 'PENDING' || isExpired(inv.expiresAt, now)) throw invalid();
      await setTenantSalon(tx, inv.salonId);
      const profile = await this.repo.findLiveProfileName(tx, inv.salonId, inv.staffId);
      if (!profile || !profile.isActive || profile.userId) throw invalid();
      const userId = await this.repo.insertStaffUser(tx, { email: inv.email, passwordHash, fullName: dto.fullName.trim() }, now);
      if (!userId) throw new AppException('CONFLICT', 'An account with this e-mail already exists. Sign in instead.', 409);
      if (!(await this.repo.linkProfileToUser(tx, inv.salonId, inv.staffId, userId, now))) throw invalid();
      if (!(await this.repo.markInvitationAccepted(tx, inv.id, userId, now))) throw invalid();
      await insertAudit(tx, {
        actorUserId: userId, actorRole: 'SALON_STAFF', action: 'staff.invitation_accepted', targetType: 'staff_profile',
        targetId: inv.staffId, salonId: inv.salonId, ipAddress: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });
      return { status: 'ACCEPTED' as const, email: inv.email };
    });
  }

  /** Same HIBP rules as registration (auth.service): breached passwords refused; availability fail-open by default. */
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
}
