import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button, Card, ConfirmDialog, ErrorState, Skeleton, StatusBadge } from '../../design-system';
import { ApiError, apiFetch, apiJson } from '../../lib/api';
import { useAuth } from '../auth/AuthContext';
import { FileViewer } from './FileViewer';
import { DOC_LABEL, SalonDetail, SalonFileMeta, TYPE_LABEL, badgeOf } from './types';

type Action = 'approve' | 'reject' | 'suspend' | 'reactivate';
const COPY: Record<Action, { title: string; confirm: string; destructive: boolean; reason: number; blurb: string }> = {
  approve: { title: 'Approve this salon?', confirm: 'Approve', destructive: false, reason: 0, blurb: 'The salon becomes visible to customers and the owner is notified.' },
  reject: { title: 'Reject this application?', confirm: 'Reject', destructive: true, reason: 10, blurb: 'The owner sees your reason, can correct the details and submit again.' },
  suspend: { title: 'Suspend this salon?', confirm: 'Suspend', destructive: true, reason: 5, blurb: 'The salon disappears from public search immediately.' },
  reactivate: { title: 'Reactivate this salon?', confirm: 'Reactivate', destructive: false, reason: 0, blurb: 'The salon becomes visible to customers again.' },
};

const kb = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const when = (d: string | null) => (d ? new Date(d).toLocaleString() : '-');

export function SalonDetailPage() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['salon', id], queryFn: () => apiFetch<SalonDetail>(`/admin/salons/${id}`) });
  const [action, setAction] = useState<Action | null>(null);
  const [reason, setReason] = useState('');
  const [viewing, setViewing] = useState<SalonFileMeta | null>(null);

  // UX only: the API enforces salons.review / salons.manage_status / salons.documents_read.
  const isSuper = user?.role === 'SUPER_ADMIN';

  const decide = useMutation({
    mutationFn: (v: { action: Action; reason: string }) => apiJson(`/admin/salons/${id}/${v.action}`, 'POST', v.reason ? { reason: v.reason } : undefined),
    onSuccess: () => {
      setAction(null);
      setReason('');
      void qc.invalidateQueries({ queryKey: ['salon', id] });
      void qc.invalidateQueries({ queryKey: ['salons'] });
      void qc.invalidateQueries({ queryKey: ['salon-stats'] });
    },
  });

  if (q.isLoading) return <div className="space-y-4"><Skeleton className="h-10 w-64" /><Skeleton className="h-48" /><Skeleton className="h-48" /></div>;
  if (q.error) {
    const e = q.error as ApiError;
    return (
      <div>
        <Link to="/salons" className="inline-flex items-center gap-2 text-sm text-muted hover:underline"><ArrowLeft className="size-4" aria-hidden />Back to salons</Link>
        <Card className="mt-4"><ErrorState message={e.status === 404 ? 'This salon does not exist or has not been submitted.' : e.message} requestId={e.requestId} onRetry={() => void q.refetch()} /></Card>
      </div>
    );
  }
  const d = q.data!;
  const s = d.salon;
  const copy = action ? COPY[action] : null;
  const reasonTooShort = copy ? copy.reason > 0 && reason.trim().length < copy.reason : false;
  const err = decide.error instanceof ApiError ? decide.error : null;
  const documents = d.files.filter((f) => f.kind === 'DOCUMENT');
  const photos = d.files.filter((f) => f.kind === 'PHOTO');

  const row = (label: string, value: string | null | undefined) => (
    <div className="flex justify-between gap-4 py-2 text-sm"><dt className="text-muted">{label}</dt><dd className="min-w-0 break-words text-right">{value || '-'}</dd></div>
  );
  const fileRow = (f: SalonFileMeta) => {
    const blocked = f.kind === 'DOCUMENT' && !d.canViewDocuments;
    return (
      <li key={f.id} className="flex items-center justify-between gap-3 py-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{DOC_LABEL[f.docType] ?? f.docType}</p>
          <p className="truncate text-xs text-muted">{f.contentType === 'application/pdf' ? 'PDF' : 'Image'} · {kb(f.sizeBytes)}{f.originalName ? ` · ${f.originalName}` : ''}</p>
        </div>
        <Button variant="secondary" disabled={blocked} title={blocked ? 'Only a Super Admin can open identity documents' : undefined} onClick={() => setViewing(f)}>View</Button>
      </li>
    );
  };

  return (
    <div>
      <Link to="/salons" className="inline-flex items-center gap-2 text-sm text-muted hover:underline"><ArrowLeft className="size-4" aria-hidden />Back to salons</Link>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-4xl">{s.name}</h1>
          <p className="mt-1 text-muted">{TYPE_LABEL[s.salonType]} · {s.city}, {s.area}</p>
        </div>
        <StatusBadge status={badgeOf(s.status)} />
      </div>

      {s.status === 'REJECTED' && s.rejectionReason && <Card className="mt-6 border-danger/40"><p className="text-sm font-medium">Rejection reason</p><p className="mt-1 text-sm text-muted">{s.rejectionReason}</p></Card>}
      {s.status === 'SUSPENDED' && s.suspendedReason && <Card className="mt-6 border-danger/40"><p className="text-sm font-medium">Suspension reason</p><p className="mt-1 text-sm text-muted">{s.suspendedReason}</p></Card>}

      {isSuper && (
        <div className="mt-6 flex flex-wrap gap-2">
          {s.status === 'PENDING' && (<><Button onClick={() => setAction('approve')}>Approve</Button><Button variant="destructive" onClick={() => setAction('reject')}>Reject</Button></>)}
          {s.status === 'APPROVED' && <Button variant="destructive" onClick={() => setAction('suspend')}>Suspend</Button>}
          {s.status === 'SUSPENDED' && <Button onClick={() => setAction('reactivate')}>Reactivate</Button>}
        </div>
      )}

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="text-2xl">Salon</h2>
          <dl className="mt-2 divide-y divide-line">
            {row('Address', s.addressLine)}{row('Phone', s.phone)}{row('Contact e-mail', s.contactEmail)}{row('Description', s.description)}
            {row('Location', s.latitude !== null && s.longitude !== null ? `${s.latitude}, ${s.longitude}` : null)}
            {row('Submitted', when(s.submittedAt))}{row('Approved', when(s.approvedAt))}
          </dl>
        </Card>
        <Card>
          <h2 className="text-2xl">Owner</h2>
          <dl className="mt-2 divide-y divide-line">{row('Name', d.owner?.fullName)}{row('E-mail', d.owner?.email)}{row('Phone', d.owner?.phone)}</dl>
        </Card>
        <Card>
          <h2 className="text-2xl">Documents</h2>
          {!d.canViewDocuments && <p className="mt-1 text-sm text-muted">Identity documents can only be opened by a Super Admin.</p>}
          {documents.length === 0 ? <p className="mt-3 text-sm text-muted">No documents.</p> : <ul className="mt-2 divide-y divide-line">{documents.map(fileRow)}</ul>}
        </Card>
        <Card>
          <h2 className="text-2xl">Photos</h2>
          {photos.length === 0 ? <p className="mt-3 text-sm text-muted">No photos.</p> : <ul className="mt-2 divide-y divide-line">{photos.map(fileRow)}</ul>}
        </Card>
      </div>

      <Card className="mt-4">
        <h2 className="text-2xl">Application history</h2>
        <ul className="mt-2 divide-y divide-line">
          {d.applications.map((a) => (
            <li key={a.id} className="py-3 text-sm">
              <span className="font-medium">Submission #{a.submissionNo}</span> · {a.status.toLowerCase()} · submitted {when(a.submittedAt)}
              {a.reviewedAt && <> · reviewed {when(a.reviewedAt)}</>}
              {a.decisionReason && <p className="mt-1 text-muted">Reason: {a.decisionReason}</p>}
            </li>
          ))}
        </ul>
      </Card>

      <FileViewer salonId={id} file={viewing} onClose={() => setViewing(null)} />

      <ConfirmDialog
        open={action !== null}
        title={copy?.title ?? ''}
        confirmLabel={copy?.confirm}
        destructive={copy?.destructive}
        loading={decide.isPending}
        onCancel={() => { setAction(null); setReason(''); decide.reset(); }}
        onConfirm={() => { if (action && !reasonTooShort) decide.mutate({ action, reason: reason.trim() }); }}
      >
        <p>{copy?.blurb}</p>
        {copy && copy.reason > 0 && (
          <div className="mt-3">
            <label htmlFor="decision-reason" className="mb-1.5 block text-sm font-medium">Reason (shown to the owner, recorded in the audit log)</label>
            <textarea id="decision-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)}
              className="w-full rounded-input border border-line bg-surface p-3 text-sm outline-none focus:border-gold focus:ring-1 focus:ring-gold" />
            {reason.trim().length > 0 && reasonTooShort && <p className="mt-1 text-danger">At least {copy.reason} characters.</p>}
          </div>
        )}
        {err && <p role="alert" className="mt-2 text-danger">{err.message}</p>}
      </ConfirmDialog>
    </div>
  );
}
