import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, ErrorState, Input, ResponsiveTable, Skeleton, StatusBadge } from '../../design-system';
import type { Column } from '../../design-system';
import { ApiError, apiFetch } from '../../lib/api';
import { SalonList, SalonRow, SalonStats, TYPE_LABEL, badgeOf } from './types';

const TABS: Array<{ key: '' | SalonRow['status']; label: string; stat?: keyof SalonStats }> = [
  { key: 'PENDING', label: 'Pending', stat: 'pending' },
  { key: 'APPROVED', label: 'Approved', stat: 'approved' },
  { key: 'REJECTED', label: 'Rejected', stat: 'rejected' },
  { key: 'SUSPENDED', label: 'Suspended', stat: 'suspended' },
  { key: '', label: 'All' },
];

export function SalonsPage() {
  const [tab, setTab] = useState<'' | SalonRow['status']>('PENDING');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);

  const params = new URLSearchParams({ page: String(page), pageSize: '20' });
  if (tab) params.set('status', tab);
  if (q.trim()) params.set('q', q.trim());
  const list = useQuery({ queryKey: ['salons', params.toString()], queryFn: () => apiFetch<SalonList>(`/admin/salons?${params}`) });
  const stats = useQuery({ queryKey: ['salon-stats'], queryFn: () => apiFetch<SalonStats>('/admin/salons/stats') });

  const columns: Column<SalonRow>[] = [
    { key: 'name', header: 'Salon', primary: true, cell: (s) => <Link className="font-semibold underline-offset-2 hover:underline" to={`/salons/${s.id}`}>{s.name}</Link> },
    { key: 'owner', header: 'Owner', cell: (s) => <span>{s.ownerName}<br /><span className="text-xs text-muted">{s.ownerEmail}</span></span> },
    { key: 'place', header: 'City / area', cell: (s) => `${s.city}, ${s.area}` },
    { key: 'type', header: 'Type', cell: (s) => TYPE_LABEL[s.salonType] },
    { key: 'status', header: 'Status', cell: (s) => <StatusBadge status={badgeOf(s.status)} /> },
    { key: 'submitted', header: 'Submitted', cell: (s) => (s.submittedAt ? new Date(s.submittedAt).toLocaleDateString() : '-') },
    { key: 'open', header: '', cell: (s) => <Link to={`/salons/${s.id}`}><Button variant="secondary" tabIndex={-1}>Review</Button></Link> },
  ];

  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;
  return (
    <div>
      <h1 className="text-4xl">Salons</h1>
      <p className="mt-1 text-muted">Review applications and manage approved salons. A salon is public only while approved.</p>

      <div role="tablist" aria-label="Salon status" className="mt-6 flex flex-wrap gap-2">
        {TABS.map((t) => {
          const count = t.stat && stats.data ? stats.data[t.stat] : null;
          const active = tab === t.key;
          return (
            <button
              key={t.label}
              role="tab"
              type="button"
              aria-selected={active}
              onClick={() => { setTab(t.key); setPage(1); }}
              className={`min-h-11 rounded-input px-4 text-sm font-medium transition-colors ${active ? 'bg-ink text-ivory dark:bg-gold dark:text-ink' : 'border border-line bg-surface hover:bg-sand'}`}
            >
              {t.label}{count !== null && <span className="ml-2 opacity-70">{count}</span>}
            </button>
          );
        })}
      </div>

      <div className="mt-4 max-w-md">
        <Input label="Search" placeholder="Salon, city, area or owner e-mail" value={q} maxLength={80} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
      </div>

      <Card className="mt-6 p-0 sm:p-2">
        {list.isLoading ? (
          <div className="space-y-3 p-4"><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
        ) : list.error ? (
          <ErrorState message={(list.error as ApiError).message} requestId={(list.error as ApiError).requestId} onRetry={() => void list.refetch()} />
        ) : (
          <ResponsiveTable
            columns={columns}
            rows={list.data?.items ?? []}
            rowKey={(s) => s.id}
            emptyTitle={tab === 'PENDING' ? 'No applications waiting' : 'No salons match'}
            emptyMessage={tab === 'PENDING' ? 'New salon applications will appear here.' : 'Try a different search or filter.'}
          />
        )}
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
