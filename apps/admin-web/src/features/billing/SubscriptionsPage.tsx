import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, ErrorState, Input, ResponsiveTable, Skeleton, StatCard } from '../../design-system';
import type { Column } from '../../design-system';
import { ApiError, apiFetch } from '../../lib/api';
import { Overview, PHASE_LABEL, Phase, SubscriptionList, SubscriptionRow, day, pkr } from './types';
import { PhasePill } from './ui';

const TABS: Array<{ key: '' | Phase; label: string }> = [
  { key: '', label: 'All' }, { key: 'EXPIRED', label: 'Expired' }, { key: 'GRACE', label: 'Grace period' },
  { key: 'ACTIVE', label: 'Active' }, { key: 'NONE', label: 'Not subscribed' }, { key: 'SUSPENDED', label: 'Suspended' },
];

export function SubscriptionsPage() {
  const [tab, setTab] = useState<'' | Phase>('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const params = new URLSearchParams({ page: String(page), pageSize: '20' });
  if (tab) params.set('phase', tab);
  if (q.trim()) params.set('q', q.trim());
  const list = useQuery({ queryKey: ['subscriptions', params.toString()], queryFn: () => apiFetch<SubscriptionList>(`/admin/subscriptions?${params}`) });
  const ov = useQuery({ queryKey: ['billing-overview'], queryFn: () => apiFetch<Overview>('/admin/billing/overview') });

  const columns: Column<SubscriptionRow>[] = [
    { key: 'salon', header: 'Salon', primary: true, cell: (s) => <Link className="font-semibold underline-offset-2 hover:underline" to={`/subscriptions/${s.salonId}`}>{s.salonName}<br /><span className="text-xs font-normal text-muted">{s.city}</span></Link> },
    { key: 'owner', header: 'Owner', cell: (s) => <span>{s.ownerName}<br /><span className="text-xs text-muted">{s.ownerEmail}</span></span> },
    { key: 'phase', header: 'Status', cell: (s) => <PhasePill phase={s.phase} /> },
    { key: 'cycle', header: 'Plan', cell: (s) => (s.billingCycle ? s.billingCycle.toLowerCase() : '-') },
    { key: 'end', header: 'Paid until', cell: (s) => (s.periodEnd ? day(s.periodEnd) : '-') },
    { key: 'staff', header: 'Staff (covered / now)', cell: (s) => `${s.coveredStaff ?? '-'} / ${s.billableStaff}` },
    { key: 'open', header: 'Open invoice', cell: (s) => (s.openInvoiceNo ? `${s.openInvoiceNo} · ${pkr(s.openInvoiceTotal)}` : '-') },
  ];
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;
  return (
    <div>
      <h1 className="text-4xl">Subscriptions</h1>
      <p className="mt-1 text-muted">Per active service-performing staff member. Subscription revenue is platform revenue; salon takings never appear here.</p>

      {ov.data && (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Monthly recurring revenue" value={pkr(ov.data.monthlyRecurringRevenue)} hint="Running subscriptions, monthly-equivalent" />
          <StatCard label="Verified this month" value={pkr(ov.data.verifiedRevenueThisMonth)} hint={`This year: ${pkr(ov.data.verifiedRevenueThisYear)}`} />
          <StatCard label="Payments to verify" value={ov.data.pendingPayments} hint={pkr(ov.data.pendingAmount)} />
          <StatCard label="Active / grace / expired" value={`${ov.data.subscriptions.ACTIVE} / ${ov.data.subscriptions.GRACE} / ${ov.data.subscriptions.EXPIRED}`} hint={`${ov.data.subscriptions.NONE} not subscribed · ${ov.data.subscriptions.SUSPENDED} suspended`} />
        </div>
      )}

      <div role="tablist" aria-label="Subscription status" className="mt-6 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button key={t.label} role="tab" type="button" aria-selected={tab === t.key} onClick={() => { setTab(t.key); setPage(1); }}
            className={`min-h-11 rounded-input px-4 text-sm font-medium transition-colors ${tab === t.key ? 'bg-ink text-ivory dark:bg-gold dark:text-ink' : 'border border-line bg-surface hover:bg-sand'}`}>
            {t.label}{t.key && ov.data ? <span className="ml-2 opacity-70">{ov.data.subscriptions[t.key]}</span> : null}
          </button>
        ))}
      </div>
      <div className="mt-4 max-w-md"><Input label="Search" placeholder="Salon, city or owner e-mail" value={q} maxLength={80} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></div>

      <Card className="mt-6 p-0 sm:p-2">
        {list.isLoading ? <div className="space-y-3 p-4"><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
          : list.error ? <ErrorState message={(list.error as ApiError).message} requestId={(list.error as ApiError).requestId} onRetry={() => void list.refetch()} />
          : <ResponsiveTable columns={columns} rows={list.data?.items ?? []} rowKey={(s) => s.salonId}
              emptyTitle="No salons match" emptyMessage={tab ? `No salon is currently "${PHASE_LABEL[tab]}".` : 'Approved salons appear here.'} />}
      </Card>
      {list.data && list.data.total > list.data.pageSize && (
        <div className="mt-4 flex items-center justify-between text-sm">
          <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <span>Page {page} of {pages}</span>
          <Button variant="secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      )}
    </div>
  );
}
