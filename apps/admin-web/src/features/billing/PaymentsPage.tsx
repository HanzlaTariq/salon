import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, ErrorState, Input, ResponsiveTable, Skeleton } from '../../design-system';
import type { Column } from '../../design-system';
import { ApiError, apiFetch } from '../../lib/api';
import { PaymentReviewDialog } from './PaymentReviewDialog';
import { AdminPayment, METHOD_LABEL, KIND_LABEL, Overview, PaymentList, PaymentStatus, pkr, when } from './types';
import { PaymentPill } from './ui';

const TABS: Array<{ key: '' | PaymentStatus; label: string }> = [
  { key: 'PENDING', label: 'Awaiting review' },
  { key: 'NEEDS_INFO', label: 'Needs info' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'REJECTED', label: 'Rejected' },
  { key: '', label: 'All' },
];

export function PaymentsPage() {
  const [tab, setTab] = useState<'' | PaymentStatus>('PENDING');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);

  const params = new URLSearchParams({ page: String(page), pageSize: '20' });
  if (tab) params.set('status', tab);
  if (q.trim()) params.set('q', q.trim());
  const list = useQuery({ queryKey: ['payments', params.toString()], queryFn: () => apiFetch<PaymentList>(`/admin/payments?${params}`), refetchInterval: 60_000 });
  const overview = useQuery({ queryKey: ['billing-overview'], queryFn: () => apiFetch<Overview>('/admin/billing/overview') });

  const columns: Column<AdminPayment>[] = [
    { key: 'salon', header: 'Salon', primary: true, cell: (p) => <button type="button" className="text-left font-semibold underline-offset-2 hover:underline" onClick={() => setOpen(p.id)}>{p.salon.name}<br /><span className="text-xs font-normal text-muted">{p.salon.city}</span></button> },
    { key: 'invoice', header: 'Invoice', cell: (p) => <span>{p.invoice.invoiceNo}<br /><span className="text-xs text-muted">{KIND_LABEL[p.invoice.kind] ?? p.invoice.kind}</span></span> },
    { key: 'amount', header: 'Amount', cell: (p) => pkr(p.amount) },
    { key: 'method', header: 'Method / ID', cell: (p) => <span>{METHOD_LABEL[p.method]}<br /><span className="font-mono text-xs text-muted">{p.transactionId}</span></span> },
    { key: 'status', header: 'Status', cell: (p) => <PaymentPill status={p.status} /> },
    { key: 'at', header: 'Submitted', cell: (p) => when(p.submittedAt) },
    { key: 'open', header: '', cell: (p) => <Button variant="secondary" onClick={() => setOpen(p.id)}>{p.status === 'PENDING' ? 'Verify' : 'Open'}</Button> },
  ];
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;

  return (
    <div>
      <h1 className="text-4xl">Payments</h1>
      <p className="mt-1 text-muted">Manual verification of JazzCash, Easypaisa and bank transfers. A payment is never counted before you approve it.</p>
      {overview.data && (
        <p className="mt-3 text-sm text-muted">{overview.data.pendingPayments} payment(s) open · {pkr(overview.data.pendingAmount)} waiting</p>
      )}

      <div role="tablist" aria-label="Payment status" className="mt-6 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button key={t.label} role="tab" type="button" aria-selected={tab === t.key} onClick={() => { setTab(t.key); setPage(1); }}
            className={`min-h-11 rounded-input px-4 text-sm font-medium transition-colors ${tab === t.key ? 'bg-ink text-ivory dark:bg-gold dark:text-ink' : 'border border-line bg-surface hover:bg-sand'}`}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="mt-4 max-w-md"><Input label="Search" placeholder="Salon, transaction ID or invoice number" value={q} maxLength={80} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></div>

      <Card className="mt-6 p-0 sm:p-2">
        {list.isLoading ? <div className="space-y-3 p-4"><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
          : list.error ? <ErrorState message={(list.error as ApiError).message} requestId={(list.error as ApiError).requestId} onRetry={() => void list.refetch()} />
          : <ResponsiveTable columns={columns} rows={list.data?.items ?? []} rowKey={(p) => p.id}
              emptyTitle={tab === 'PENDING' ? 'Nothing to verify' : 'No payments match'} emptyMessage={tab === 'PENDING' ? 'New payments submitted by salon owners appear here.' : 'Try a different filter.'} />}
      </Card>

      {list.data && list.data.total > list.data.pageSize && (
        <div className="mt-4 flex items-center justify-between text-sm">
          <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <span>Page {page} of {pages}</span>
          <Button variant="secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      )}
      <PaymentReviewDialog paymentId={open} onClose={() => setOpen(null)} />
    </div>
  );
}
