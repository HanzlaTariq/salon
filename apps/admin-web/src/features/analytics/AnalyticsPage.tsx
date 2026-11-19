import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Card, ErrorState, ResponsiveTable, Skeleton, StatCard } from '../../design-system';
import { ApiError, apiFetch } from '../../lib/api';
import { pkr } from '../billing/types';
import { BarChart } from './BarChart';
import { moneyToNumber, monthLabel, num, pctText, presetRange } from './format';
import { Cities, CityRow, Overview, PresetKey, RANGE_PRESETS, Trend } from './types';

const qs = (r: { from: string; to: string }) => `from=${r.from}&to=${r.to}`;

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-2xl">{title}</h2>
      {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function QueryError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const e = error as ApiError;
  return (
    <Card>
      <ErrorState message={e.message ?? 'Could not load this section.'} requestId={e.requestId} onRetry={onRetry} />
    </Card>
  );
}

/** Phase 13: platform analytics. Booking COUNTS and PLATFORM subscription revenue only; a salon's own takings and costs are private to that salon. */
export function AnalyticsPage() {
  const [preset, setPreset] = useState<PresetKey>('30');
  const range = useMemo(() => presetRange(new Date(), RANGE_PRESETS.find((p) => p.key === preset)!.days), [preset]);

  const overview = useQuery({ queryKey: ['analytics', 'overview', range], queryFn: () => apiFetch<Overview>(`/admin/analytics/overview?${qs(range)}`) });
  const trend = useQuery({ queryKey: ['analytics', 'trend'], queryFn: () => apiFetch<Trend>('/admin/analytics/trend?months=12') });
  const cities = useQuery({ queryKey: ['analytics', 'cities', range], queryFn: () => apiFetch<Cities>(`/admin/analytics/cities?${qs(range)}`) });

  const o = overview.data;
  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-4xl">Analytics</h1>
          <p className="mt-1 text-muted">Platform-wide numbers. Dates are Pakistan time (Asia/Karachi).</p>
        </div>
        <div role="group" aria-label="Period" className="flex flex-wrap gap-2">
          {RANGE_PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              aria-pressed={preset === p.key}
              onClick={() => setPreset(p.key)}
              className={`min-h-11 rounded-input border px-4 text-sm font-medium transition-colors ${preset === p.key ? 'border-ink bg-ink text-ivory dark:border-gold dark:bg-gold dark:text-ink' : 'border-line bg-surface hover:bg-sand'}`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {o && <p className="mt-2 text-sm text-muted">Showing {o.range.from} to {o.range.to} ({o.range.days} days)</p>}

      {overview.isLoading ? (
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-28" />)}</div>
      ) : overview.error ? (
        <div className="mt-8"><QueryError error={overview.error} onRetry={() => void overview.refetch()} /></div>
      ) : o ? (
        <>
          <Section title="Platform" hint="Right now, regardless of the period above (except the 'new' figures).">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard label="Approved salons" value={num(o.salons.byStatus.APPROVED)} hint={`${num(o.salons.total)} registered in total`} />
              <StatCard label="Pending applications" value={num(o.salons.byStatus.PENDING)} hint={`${num(o.salons.applicationsSubmittedInRange)} submitted in this period`} />
              <StatCard label="Suspended salons" value={num(o.salons.byStatus.SUSPENDED)} hint={`${num(o.salons.byStatus.REJECTED)} rejected`} />
              <StatCard label="Active staff" value={num(o.staff.active)} hint={`${num(o.staff.billable)} billable`} />
              <StatCard label="Registered customers" value={num(o.customers.registered)} hint={`+${num(o.customers.newInRange)} in this period`} />
              <StatCard label="Salon owners" value={num(o.owners.registered)} hint={`+${num(o.owners.newInRange)} in this period`} />
              <StatCard label="Approved in period" value={num(o.salons.approvedInRange)} hint={`${num(o.salons.rejectedInRange)} rejected`} />
            </div>
          </Section>

          <Section title="Subscription revenue" hint="What salons pay the platform (manually verified payments). This is NOT salon takings.">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard label="Monthly recurring revenue" value={pkr(o.platformRevenue.monthlyRecurringRevenue)} hint={`${pkr(o.platformRevenue.annualRunRate)} per year at this rate`} />
              <StatCard label="Verified this month" value={pkr(o.platformRevenue.verifiedThisMonth)} />
              <StatCard label="Verified this year" value={pkr(o.platformRevenue.verifiedThisYear)} />
              <StatCard label="Awaiting verification" value={pkr(o.platformRevenue.pendingAmount)} hint={`${num(o.platformRevenue.pendingPayments)} payments`} />
              <StatCard label="Active subscriptions" value={num(o.subscriptions.active)} hint={`${num(o.subscriptions.inGrace)} in grace period`} />
              <StatCard label="Expired" value={num(o.subscriptions.expired)} hint="Past the grace period" />
              <StatCard label="Suspended" value={num(o.subscriptions.suspended)} />
              <StatCard label="Never subscribed" value={num(o.subscriptions.neverSubscribed)} />
            </div>
            <Card className="mt-4">
              <h3 className="text-lg">Verified revenue per month</h3>
              {trend.isLoading ? <Skeleton className="mt-4 h-44" /> : trend.error ? <QueryError error={trend.error} onRetry={() => void trend.refetch()} /> : trend.data && (
                <div className="mt-4">
                  <BarChart tone="emerald" title="Verified subscription revenue per month" data={trend.data.subscriptionRevenue.map((p) => ({ label: monthLabel(p.month), value: moneyToNumber(p.verified), display: pkr(p.verified).replace('Rs. ', '').replace(/\.00$/, '') }))} />
                </div>
              )}
            </Card>
          </Section>

          <Section title="Bookings" hint="Counts only. A salon's prices and takings are private to that salon.">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard label="Appointments" value={num(o.bookings.total)} hint={`${num(o.bookings.online)} online, ${num(o.bookings.walkIn)} walk-in (${pctText(o.bookings.walkInSharePct)})`} />
              <StatCard label="Completed" value={num(o.bookings.completed)} hint={`Completion rate ${pctText(o.bookings.rates.completionRate)}`} />
              <StatCard label="Cancelled" value={num(o.bookings.cancelled)} hint={`Rate ${pctText(o.bookings.rates.cancellationRate)}`} />
              <StatCard label="No-shows" value={num(o.bookings.noShow)} hint={`Rate ${pctText(o.bookings.rates.noShowRate)}`} />
            </div>
            <p className="mt-2 text-xs text-muted">Rates are taken over resolved appointments (completed + cancelled + no-show). {num(o.bookings.open)} are still open.</p>
            <Card className="mt-4">
              <h3 className="text-lg">Growth, last 12 months</h3>
              {trend.isLoading ? <Skeleton className="mt-4 h-44" /> : trend.data && (
                <div className="mt-4 grid gap-8 lg:grid-cols-2">
                  <div><p className="mb-2 text-sm text-muted">Appointments</p><BarChart title="Appointments per month" data={trend.data.growth.map((p) => ({ label: monthLabel(p.month), value: p.appointments, display: num(p.appointments) }))} /></div>
                  <div><p className="mb-2 text-sm text-muted">New customers</p><BarChart tone="info" title="New customers per month" data={trend.data.growth.map((p) => ({ label: monthLabel(p.month), value: p.newCustomers, display: num(p.newCustomers) }))} /></div>
                  <div><p className="mb-2 text-sm text-muted">New salons</p><BarChart tone="emerald" title="New salons per month" data={trend.data.growth.map((p) => ({ label: monthLabel(p.month), value: p.newSalons, display: num(p.newSalons) }))} /></div>
                </div>
              )}
            </Card>
          </Section>
        </>
      ) : null}

      <Section title="Cities" hint="Live salons (approved or suspended) grouped by city, busiest first.">
        <Card className="p-0">
          {cities.isLoading ? (
            <div className="space-y-2 p-5">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-10" />)}</div>
          ) : cities.error ? (
            <QueryError error={cities.error} onRetry={() => void cities.refetch()} />
          ) : (
            <ResponsiveTable<CityRow>
              rows={cities.data?.items ?? []}
              rowKey={(r) => r.city.toLowerCase()}
              emptyTitle="No live salons yet"
              emptyMessage="Cities appear here once salons are approved."
              columns={[
                { key: 'city', header: 'City', primary: true, cell: (r) => <span className="font-medium">{r.city}</span> },
                { key: 'salons', header: 'Salons', cell: (r) => (r.suspendedSalons > 0 ? `${r.approvedSalons} (+${r.suspendedSalons} suspended)` : String(r.approvedSalons)) },
                { key: 'staff', header: 'Active staff', cell: (r) => num(r.activeStaff) },
                { key: 'subs', header: 'Subscribed', cell: (r) => num(r.subscribedSalons) },
                { key: 'appts', header: 'Appointments', cell: (r) => num(r.appointments) },
                { key: 'done', header: 'Completed', cell: (r) => `${num(r.completed)} (${pctText(r.rates.completionRate)})` },
                { key: 'cancel', header: 'Cancelled', cell: (r) => num(r.cancelled) },
                { key: 'ns', header: 'No-shows', cell: (r) => num(r.noShow) },
              ]}
            />
          )}
        </Card>
      </Section>
    </div>
  );
}
