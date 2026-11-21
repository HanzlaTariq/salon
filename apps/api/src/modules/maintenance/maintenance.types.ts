export interface OrphanPlan {
  /** Every candidate (old enough) that no database row references. */
  orphans: string[];
  /** The subset that may be deleted in this run (empty when a safety check says no). */
  toRemove: string[];
  skippedReason: 'REPORT_ONLY' | 'TOO_MANY_ORPHANS' | 'LISTING_TRUNCATED' | null;
}

/** If more than this share of the old objects looks orphaned, the database is probably the wrong one: delete nothing. */
export const MAX_ORPHAN_RATIO = 0.5;
/** The ratio check only means something with a few files; tiny buckets (a fresh install) are exempt. */
export const RATIO_CHECK_MIN_FILES = 20;

/**
 * Decides what a reconciliation run may delete. Pure function so every safety rule is unit tested.
 * Safety rules, in this order:
 *   - report-only mode never deletes;
 *   - a cut-off listing cannot cause a wrong delete (references are looked up per key), but the counts of such a run are
 *     incomplete, so deletion waits for a complete listing;
 *   - if over half of a non-trivial bucket looks orphaned (wrong database, restored backup, outage), delete nothing;
 *   - never more than `maxRemovals` per run.
 */
export function planOrphans(
  oldKeys: readonly string[],
  inUse: ReadonlySet<string>,
  opts: { deleteEnabled: boolean; listingTruncated: boolean; maxRemovals: number },
): OrphanPlan {
  const orphans = oldKeys.filter((k) => !inUse.has(k));
  if (orphans.length === 0) return { orphans, toRemove: [], skippedReason: null };
  if (!opts.deleteEnabled) return { orphans, toRemove: [], skippedReason: 'REPORT_ONLY' };
  if (opts.listingTruncated) return { orphans, toRemove: [], skippedReason: 'LISTING_TRUNCATED' };
  if (oldKeys.length >= RATIO_CHECK_MIN_FILES && orphans.length / oldKeys.length > MAX_ORPHAN_RATIO) {
    return { orphans, toRemove: [], skippedReason: 'TOO_MANY_ORPHANS' };
  }
  return { orphans, toRemove: orphans.slice(0, Math.max(0, opts.maxRemovals)), skippedReason: null };
}
