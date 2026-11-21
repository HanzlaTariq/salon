import { planOrphans } from './maintenance.types';

const keys = (n: number) => Array.from({ length: n }, (_, i) => `k${i}`);
const base = { deleteEnabled: true, listingTruncated: false, maxRemovals: 200 };

describe('planOrphans (what a reconciliation run may delete)', () => {
  it('finds nothing when every file is referenced', () => {
    const all = keys(30);
    expect(planOrphans(all, new Set(all), base)).toEqual({ orphans: [], toRemove: [], skippedReason: null });
  });

  it('report-only mode lists orphans but deletes nothing', () => {
    const r = planOrphans(keys(30), new Set(keys(29)), { ...base, deleteEnabled: false });
    expect(r.orphans).toEqual(['k29']);
    expect(r.toRemove).toEqual([]);
    expect(r.skippedReason).toBe('REPORT_ONLY');
  });

  it('deletes only unreferenced files when enabled', () => {
    const r = planOrphans(keys(30), new Set(keys(28)), base);
    expect(r.toRemove).toEqual(['k28', 'k29']);
    expect(r.skippedReason).toBeNull();
  });

  it('refuses to delete when over half of a real-sized bucket looks orphaned (wrong database / restored backup)', () => {
    const r = planOrphans(keys(40), new Set(keys(10)), base);
    expect(r.orphans.length).toBe(30);
    expect(r.toRemove).toEqual([]);
    expect(r.skippedReason).toBe('TOO_MANY_ORPHANS');
  });

  it('does not apply the ratio rule to tiny buckets', () => {
    const r = planOrphans(keys(4), new Set(), base);
    expect(r.toRemove).toHaveLength(4);
  });

  it('waits for a complete listing before deleting', () => {
    const r = planOrphans(keys(30), new Set(keys(29)), { ...base, listingTruncated: true });
    expect(r.toRemove).toEqual([]);
    expect(r.skippedReason).toBe('LISTING_TRUNCATED');
  });

  it('caps the number of deletions per run', () => {
    const r = planOrphans(keys(10), new Set(), { ...base, maxRemovals: 3 });
    expect(r.toRemove).toHaveLength(3);
    expect(r.orphans).toHaveLength(10);
  });
});
