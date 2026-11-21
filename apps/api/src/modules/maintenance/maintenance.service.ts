import { Inject, Injectable, Logger } from '@nestjs/common';
import { Clock } from '../../common/util/clock';
import { ObjectStorage } from '../../common/storage/object-storage';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { ENV, Env } from '../../config/env';
import { planOrphans } from './maintenance.types';

export interface PurgeCounts {
  syncOperations: number;
  staffInvitations: number;
  authTokens: number;
  refreshTokens: number;
  sessions: number;
}

export interface StorageReport {
  scanned: number;
  /** true when the bucket has more objects than one run looks at (the rest is checked on later runs). */
  truncated: boolean;
  /** Objects old enough, and not referenced by any database row. */
  orphans: number;
  removed: number;
  /** Why nothing was removed even though orphans exist: report-only mode, or one of the safety checks. */
  skippedReason: 'REPORT_ONLY' | 'TOO_MANY_ORPHANS' | 'LISTING_TRUNCATED' | null;
}

export interface MaintenanceReport {
  startedAt: string;
  durationMs: number;
  purged: PurgeCounts;
  storage: StorageReport;
}

/** Upper bound of objects looked at per run (the Supabase listing walks folders one level at a time). */
export const MAX_OBJECTS_PER_RUN = 20_000;
const KEYS_PER_LOOKUP = 500;
/** A run never deletes more than this many files, whatever the ratio says. */
const MAX_REMOVALS_PER_RUN = 200;

/**
 * Phase 15 housekeeping, safe to run from several processes or twice in a row (the purge deletes by age, the reconciliation
 * deletes by "not referenced"; both are idempotent):
 *   1) retention: `maintenance_purge()` removes dead tokens, ended sessions, finished invitations and old offline-ledger rows;
 *   2) storage reconciliation (risks R19, R29): files in the private bucket that no database row points to are orphans left
 *      by a crash between "upload" and "save row". Default is REPORT ONLY; deleting needs MAINTENANCE_DELETE_ORPHANS=true.
 */
@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger('Maintenance');
  private running: Promise<MaintenanceReport> | null = null;

  constructor(
    private readonly tenant: TenantDb,
    private readonly storage: ObjectStorage,
    private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** A call made while a run is in progress joins that run (no overlapping runs inside one process). */
  run(): Promise<MaintenanceReport> {
    if (this.running) return this.running;
    this.running = this.doRun().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async doRun(): Promise<MaintenanceReport> {
    const started = this.clock.now();
    const t0 = Date.now();
    const purged = await this.purge();
    const storage = await this.reconcileStorage(started.getTime()).catch((e: unknown) => {
      // The purge already succeeded; a storage outage must not hide that.
      this.logger.error(`storage reconciliation failed: ${e instanceof Error ? e.message : 'unknown'}`);
      return { scanned: 0, truncated: false, orphans: 0, removed: 0, skippedReason: null } satisfies StorageReport;
    });
    const report: MaintenanceReport = { startedAt: started.toISOString(), durationMs: Date.now() - t0, purged, storage };
    this.logger.log({ event: 'maintenance.done', ...report });
    return report;
  }

  async purge(): Promise<PurgeCounts> {
    const rows = await this.tenant.withMaintenance((tx) => tx.$queryRaw`SELECT maintenance_purge() AS r`) as Array<{ r: PurgeCounts }>;
    const r = rows[0]?.r;
    return {
      syncOperations: Number(r?.syncOperations ?? 0),
      staffInvitations: Number(r?.staffInvitations ?? 0),
      authTokens: Number(r?.authTokens ?? 0),
      refreshTokens: Number(r?.refreshTokens ?? 0),
      sessions: Number(r?.sessions ?? 0),
    };
  }

  async reconcileStorage(nowMs: number): Promise<StorageReport> {
    const listing = await this.storage.list('', { maxObjects: MAX_OBJECTS_PER_RUN });
    const cutoff = nowMs - this.env.MAINTENANCE_ORPHAN_MIN_AGE_HOURS * 3_600_000;
    // Objects whose age is unknown are never touched.
    const old = listing.objects.filter((o) => o.createdAt !== null && o.createdAt.getTime() <= cutoff).map((o) => o.key);

    const inUse = new Set<string>();
    for (let i = 0; i < old.length; i += KEYS_PER_LOOKUP) {
      const chunk = old.slice(i, i + KEYS_PER_LOOKUP);
      const rows = await this.tenant.withMaintenance((tx) => tx.$queryRaw`SELECT maintenance_keys_in_use(${chunk}::text[]) AS keys`) as Array<{ keys: string[] }>;
      for (const k of rows[0]?.keys ?? []) inUse.add(k);
    }

    const plan = planOrphans(old, inUse, { deleteEnabled: this.env.MAINTENANCE_DELETE_ORPHANS, listingTruncated: listing.truncated, maxRemovals: MAX_REMOVALS_PER_RUN });
    let removed = 0;
    for (const key of plan.toRemove) {
      try {
        await this.storage.remove(key);
        removed += 1;
      } catch {
        this.logger.warn('Could not remove an orphaned file');
      }
    }
    if (plan.orphans.length > 0) {
      this.logger.warn({ event: 'maintenance.orphans', count: plan.orphans.length, removed, skippedReason: plan.skippedReason });
    }
    return { scanned: listing.objects.length, truncated: listing.truncated, orphans: plan.orphans.length, removed, skippedReason: plan.skippedReason };
  }
}
