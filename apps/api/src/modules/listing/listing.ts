import { Injectable, Module } from '@nestjs/common';
import { Clock } from '../../common/util/clock';
import { addDays } from '../billing/billing.types';
import { todayInSalonTz } from '../staff/staff.types';

/**
 * Phase 7: ONE rule decides whether an APPROVED salon may appear in public search and on its public pages.
 *
 *   * the salon has a subscription row  -> listed only while ACTIVE or in GRACE (billing `isOperational`)
 *   * the salon never subscribed        -> listed during the free trial: `trialDays` calendar days (Asia/Karachi)
 *                                          counted from approval. `trialDays` is a Super Admin setting.
 *
 * The same rule exists in SQL (`salon_is_listed`, migration 20261114000000) so list queries can filter in the database.
 * `listingState` below is the pure twin used for the owner's own status screen; e2e tests assert both agree.
 * Phase 8 (booking) must call the same function.
 */
export const DEFAULT_TRIAL_DAYS = 14;
export const MAX_TRIAL_DAYS = 90;
export const DISCOVERY_SETTING_KEY = 'discovery';

/** Defensive read of platform_settings.value for key `discovery`: anything unusable falls back to the default. */
export function parseTrialDays(value: unknown): number {
  const raw = value && typeof value === 'object' ? (value as { trialDays?: unknown }).trialDays : undefined;
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= MAX_TRIAL_DAYS ? raw : DEFAULT_TRIAL_DAYS;
}

export type ListingReason = 'NOT_APPROVED' | 'SUBSCRIPTION' | 'TRIAL' | 'TRIAL_ENDED' | 'SUBSCRIPTION_ENDED' | 'SUBSCRIPTION_SUSPENDED';

export interface ListingInput {
  status: string;
  approvedAt: Date | null;
  subscription: { status: string; periodEnd: string; graceDays: number } | null;
  trialDays: number;
  /** YYYY-MM-DD, Asia/Karachi. */
  today: string;
}

export interface ListingState {
  listed: boolean;
  reason: ListingReason;
  /** Last day of the free trial (only while the salon has never subscribed). */
  trialEndsOn: string | null;
}

export function listingState(i: ListingInput): ListingState {
  if (i.status !== 'APPROVED') return { listed: false, reason: 'NOT_APPROVED', trialEndsOn: null };
  if (i.subscription) {
    const s = i.subscription;
    if (s.status === 'SUSPENDED') return { listed: false, reason: 'SUBSCRIPTION_SUSPENDED', trialEndsOn: null };
    return i.today < addDays(s.periodEnd, s.graceDays)
      ? { listed: true, reason: 'SUBSCRIPTION', trialEndsOn: null }
      : { listed: false, reason: 'SUBSCRIPTION_ENDED', trialEndsOn: null };
  }
  if (!i.approvedAt) return { listed: false, reason: 'TRIAL_ENDED', trialEndsOn: null };
  const days = Math.max(0, i.trialDays);
  const first = todayInSalonTz(i.approvedAt);
  const endsOn = days === 0 ? null : addDays(first, days - 1);
  return i.today < addDays(first, days) ? { listed: true, reason: 'TRIAL', trialEndsOn: endsOn } : { listed: false, reason: 'TRIAL_ENDED', trialEndsOn: endsOn };
}

/** Minimal SQL surface (a Prisma transaction or the test adapter). */
interface Tx {
  $queryRaw<T = unknown>(q: TemplateStringsArray, ...v: unknown[]): Promise<T>;
}

@Injectable()
export class ListingPolicy {
  constructor(private readonly clock: Clock) {}

  /** Free-trial length in days. `platform_settings` has no tenant rows, so this works in every transaction context. */
  async trialDays(tx: Tx): Promise<number> {
    const r = await tx.$queryRaw<Array<{ value: unknown }>>`SELECT value FROM platform_settings WHERE key = ${DISCOVERY_SETTING_KEY}::varchar`;
    return parseTrialDays(r[0]?.value);
  }

  /** Today's calendar date in Asia/Karachi (YYYY-MM-DD), from the injectable clock.  */
  today(now: Date = this.clock.now()): string {
    return todayInSalonTz(now);
  }

  /** The two values every `salon_is_listed(...)` call needs. */
  async params(tx: Tx): Promise<{ trialDays: number; today: string }> {
    return { trialDays: await this.trialDays(tx), today: this.today() };
  }
}

@Module({ providers: [ListingPolicy], exports: [ListingPolicy] })
export class ListingModule {}
