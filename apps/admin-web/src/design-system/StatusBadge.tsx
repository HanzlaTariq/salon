export type Status =
  | 'pending'
  | 'confirmed'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'no_show'
  | 'approved'
  | 'rejected'
  | 'suspended'
  | 'active'
  | 'unverified';

/** One consistent color + label per status across the whole product. Icon-free but text-labelled (not color-only). */
const map: Record<Status, { label: string; cls: string }> = {
  pending: { label: 'Pending', cls: 'bg-warning/15 text-warning' },
  confirmed: { label: 'Confirmed', cls: 'bg-info/15 text-info' },
  in_progress: { label: 'In progress', cls: 'bg-gold/20 text-gold-hover dark:text-gold' },
  completed: { label: 'Completed', cls: 'bg-emerald/15 text-emerald dark:text-emerald' },
  cancelled: { label: 'Cancelled', cls: 'bg-sand text-muted' },
  no_show: { label: 'No show', cls: 'bg-danger/15 text-danger' },
  approved: { label: 'Approved', cls: 'bg-emerald/15 text-emerald' },
  rejected: { label: 'Rejected', cls: 'bg-danger/15 text-danger' },
  suspended: { label: 'Suspended', cls: 'bg-sand text-muted' },
  active: { label: 'Active', cls: 'bg-emerald/15 text-emerald' },
  unverified: { label: 'Unverified', cls: 'bg-warning/15 text-warning' },
};

export function StatusBadge({ status }: { status: Status }) {
  const { label, cls } = map[status];
  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${cls}`}>{label}</span>;
}
