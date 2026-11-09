import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, ConfirmDialog, ErrorState, Input, ResponsiveTable, Skeleton, StatusBadge } from '../../design-system';
import type { Column } from '../../design-system';
import { ApiError, apiFetch, apiJson } from '../../lib/api';
import { useAuth } from '../auth/AuthContext';

interface UserRow {
  id: string;
  email: string;
  fullName: string;
  role: string;
  status: 'PENDING_VERIFICATION' | 'ACTIVE' | 'SUSPENDED';
  mfaEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}
interface Page {
  items: UserRow[];
  total: number;
  page: number;
  pageSize: number;
}

const ROLES = ['', 'SUPER_ADMIN', 'SUPPORT', 'FINANCE', 'SALON_OWNER', 'SALON_STAFF', 'CUSTOMER'];
const STATUSES = ['', 'ACTIVE', 'PENDING_VERIFICATION', 'SUSPENDED'];
const badge = (s: UserRow['status']) => (s === 'ACTIVE' ? 'active' : s === 'SUSPENDED' ? 'suspended' : 'unverified');

export function UsersPage() {
  const { user: me } = useAuth();
  const qc = useQueryClient();
  const canManage = me?.role === 'SUPER_ADMIN'; // UX only; the API enforces users.manage_status
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [target, setTarget] = useState<UserRow | null>(null);
  const [reason, setReason] = useState('');

  const params = new URLSearchParams({ page: String(page), pageSize: '20' });
  if (q.trim()) params.set('q', q.trim());
  if (role) params.set('role', role);
  if (status) params.set('status', status);
  const list = useQuery({ queryKey: ['users', params.toString()], queryFn: () => apiFetch<Page>(`/admin/users?${params}`) });

  const change = useMutation({
    mutationFn: (v: { id: string; status: 'ACTIVE' | 'SUSPENDED'; reason: string }) =>
      apiJson(`/admin/users/${v.id}/status`, 'PATCH', { status: v.status, reason: v.reason }),
    onSuccess: () => {
      setTarget(null);
      setReason('');
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
  });

  const suspending = target?.status !== 'SUSPENDED';
  const columns: Column<UserRow>[] = [
    { key: 'name', header: 'Name', primary: true, cell: (u) => <span>{u.fullName}</span> },
    { key: 'email', header: 'Email', cell: (u) => u.email },
    { key: 'role', header: 'Role', cell: (u) => u.role.replace('_', ' ').toLowerCase() },
    { key: 'status', header: 'Status', cell: (u) => <StatusBadge status={badge(u.status)} /> },
    { key: 'mfa', header: '2FA', cell: (u) => (u.mfaEnabled ? 'On' : 'Off') },
    { key: 'last', header: 'Last sign-in', cell: (u) => (u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'Never') },
    ...(canManage
      ? [{
          key: 'actions',
          header: '',
          cell: (u: UserRow) =>
            u.role === 'SUPER_ADMIN' || u.id === me?.id ? null : (
              <Button variant="secondary" onClick={() => setTarget(u)}>{u.status === 'SUSPENDED' ? 'Reactivate' : 'Suspend'}</Button>
            ),
        }]
      : []),
  ];

  const err = change.error instanceof ApiError ? change.error : null;
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;

  return (
    <div>
      <h1 className="text-4xl">Users</h1>
      <p className="mt-1 text-muted">Account status for every role. Suspending signs the person out immediately.</p>

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <Input label="Search" placeholder="Name or e-mail" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        <div>
          <label htmlFor="f-role" className="mb-1.5 block text-sm font-medium">Role</label>
          <select id="f-role" className="min-h-11 w-full rounded-input border border-line bg-surface px-3 text-sm" value={role} onChange={(e) => { setRole(e.target.value); setPage(1); }}>
            {ROLES.map((r) => <option key={r} value={r}>{r ? r.replace('_', ' ') : 'All roles'}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="f-status" className="mb-1.5 block text-sm font-medium">Status</label>
          <select id="f-status" className="min-h-11 w-full rounded-input border border-line bg-surface px-3 text-sm" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            {STATUSES.map((s) => <option key={s} value={s}>{s ? s.replace('_', ' ') : 'All statuses'}</option>)}
          </select>
        </div>
      </div>

      <Card className="mt-6 p-0 sm:p-2">
        {list.isLoading ? (
          <div className="space-y-3 p-4"><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
        ) : list.error ? (
          <ErrorState message={(list.error as ApiError).message} requestId={(list.error as ApiError).requestId} onRetry={() => void list.refetch()} />
        ) : (
          <ResponsiveTable columns={columns} rows={list.data?.items ?? []} rowKey={(u) => u.id} emptyTitle="No users match" emptyMessage="Try a different search or filter." />
        )}
      </Card>

      {list.data && list.data.total > list.data.pageSize && (
        <div className="mt-4 flex items-center justify-between text-sm">
          <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <span>Page {page} of {pages}</span>
          <Button variant="secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      )}

      <ConfirmDialog
        open={target !== null}
        title={suspending ? 'Suspend this account?' : 'Reactivate this account?'}
        confirmLabel={suspending ? 'Suspend' : 'Reactivate'}
        destructive={suspending}
        loading={change.isPending}
        onCancel={() => { setTarget(null); setReason(''); change.reset(); }}
        onConfirm={() => target && change.mutate({ id: target.id, status: suspending ? 'SUSPENDED' : 'ACTIVE', reason: reason.trim() })}
      >
        <p>{target?.fullName} ({target?.email}){suspending ? ' will be signed out everywhere and cannot sign in.' : ' will be able to sign in again.'}</p>
        <div className="mt-3">
          <Input label="Reason (recorded in the audit log)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </div>
        {err && <p role="alert" className="mt-2 text-danger">{err.message}</p>}
        {reason.trim().length > 0 && reason.trim().length < 3 && <p className="mt-2 text-danger">Reason must be at least 3 characters.</p>}
      </ConfirmDialog>
    </div>
  );
}
