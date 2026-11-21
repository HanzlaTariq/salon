import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Button, Card, EmptyState, ErrorState, Skeleton } from '../../design-system';
import { ApiError, apiFetch, apiJson } from '../../lib/api';
import { useAuth } from '../auth/AuthContext';
import { Pill, TextArea } from '../billing/ui';
import { AdminReport, AdminReview, Counts, Paged, REASON_LABEL, pagesOf, reasonError, stars, when } from './types';

type Tab = 'reports' | 'all' | 'hidden';
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'reports', label: 'Reported' },
  { key: 'all', label: 'All reviews' },
  { key: 'hidden', label: 'Hidden' },
];

type Action =
  | { kind: 'hide'; review: AdminReview }
  | { kind: 'restore'; review: AdminReview }
  | { kind: 'resolve'; report: AdminReport; how: 'DISMISS' | 'HIDE_REVIEW' };

function Rating({ value, label }: { value: number | null; label: string }) {
  return <span aria-label={`${label}: ${value ?? 'none'} out of 5`} className="whitespace-nowrap"><span aria-hidden className="text-gold">{stars(value)}</span> <span className="text-xs text-muted">{value ?? '-'}</span></span>;
}

function ReviewCard({ r, canModerate, onAction }: { r: AdminReview; canModerate: boolean; onAction: (a: Action) => void }) {
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-semibold">{r.salon.name}</p>
          <p className="text-sm text-muted">{r.authorName} · {when(r.createdAt)}{r.edited ? ' · edited' : ''}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {r.openReport && <Pill tone="warn">Reported: {REASON_LABEL[r.openReport.reason]}</Pill>}
          <Pill tone={r.status === 'HIDDEN' ? 'bad' : 'good'}>{r.status === 'HIDDEN' ? 'Hidden' : 'Published'}</Pill>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <span>Salon <Rating value={r.rating} label="Salon rating" /></span>
        {r.staff.name && <span>{r.staff.name} <Rating value={r.staffRating} label="Staff rating" /></span>}
      </div>
      {r.comment ? <p className="mt-3 whitespace-pre-line break-words text-sm">{r.comment}</p> : <p className="mt-3 text-sm text-muted">No written comment.</p>}
      {r.services.length > 0 && <p className="mt-2 text-xs text-muted">{r.services.map((s) => `${s.name} ${s.rating}/5`).join(' · ')}</p>}
      {r.response && <p className="mt-3 rounded-input bg-sand p-3 text-sm"><span className="font-semibold">Salon response: </span>{r.response.text}</p>}
      {r.status === 'HIDDEN' && <p className="mt-3 text-sm text-danger">Hidden {when(r.hiddenAt)}: {r.hiddenReason}</p>}
      {canModerate && (
        <div className="mt-4 flex gap-2">
          {r.status === 'PUBLISHED' ? <Button variant="destructive" onClick={() => onAction({ kind: 'hide', review: r })}>Hide review</Button> : <Button variant="secondary" onClick={() => onAction({ kind: 'restore', review: r })}>Restore review</Button>}
        </div>
      )}
    </Card>
  );
}

function ReportCard({ r, canModerate, onAction }: { r: AdminReport; canModerate: boolean; onAction: (a: Action) => void }) {
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-semibold">{r.salonName}</p>
          <p className="text-sm text-muted">Reported {when(r.createdAt)} · {REASON_LABEL[r.reason]}</p>
        </div>
        <Pill tone={r.status === 'OPEN' ? 'warn' : r.status === 'ACTIONED' ? 'bad' : 'muted'}>{r.status === 'OPEN' ? 'Open' : r.status === 'ACTIONED' ? 'Review hidden' : 'Dismissed'}</Pill>
      </div>
      {r.details && <p className="mt-3 text-sm"><span className="font-semibold">Salon says: </span>{r.details}</p>}
      {r.review && (
        <div className="mt-3 rounded-input border border-line p-3 text-sm">
          <p className="text-muted">{r.review.authorName} · <Rating value={r.review.salonRating} label="Salon rating" /></p>
          <p className="mt-1 whitespace-pre-line break-words">{r.review.comment ?? 'No written comment.'}</p>
        </div>
      )}
      {r.resolutionNote && <p className="mt-3 text-sm text-muted">Decision note: {r.resolutionNote}</p>}
      {canModerate && r.status === 'OPEN' && (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="destructive" onClick={() => onAction({ kind: 'resolve', report: r, how: 'HIDE_REVIEW' })}>Hide the review</Button>
          <Button variant="secondary" onClick={() => onAction({ kind: 'resolve', report: r, how: 'DISMISS' })}>Keep it public</Button>
        </div>
      )}
    </Card>
  );
}

/** One dialog for every decision. A reason is required when a review is hidden; everything is confirmed server-side. */
function DecisionDialog({ action, onClose }: { action: Action | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [touched, setTouched] = useState(false);
  const needsReason = action?.kind === 'hide' || (action?.kind === 'resolve' && action.how === 'HIDE_REVIEW');
  const noteOptional = action?.kind === 'resolve';

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (action && !d.open) d.showModal();
    if (!action && d.open) d.close();
    setText(''); setTouched(false);
  }, [action]);

  const run = useMutation({
    mutationFn: () => {
      if (!action) return Promise.resolve(null);
      if (action.kind === 'hide') return apiJson(`/admin/reviews/${action.review.id}/hide`, 'POST', { reason: text.trim() });
      if (action.kind === 'restore') return apiJson(`/admin/reviews/${action.review.id}/restore`, 'POST', {});
      return apiJson(`/admin/reviews/reports/${action.report.id}/resolve`, 'POST', { action: action.how, ...(text.trim() ? { note: text.trim() } : {}) });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['reviews'] }); void qc.invalidateQueries({ queryKey: ['review-counts'] }); onClose(); },
  });
  const err = run.error instanceof ApiError ? run.error : null;
  const problem = needsReason && !noteOptional ? reasonError(text) : needsReason && text.trim() ? reasonError(text) : null;
  const blocked = needsReason && !noteOptional ? reasonError(text) !== null : problem !== null;

  const title = !action ? '' : action.kind === 'hide' ? 'Hide this review?' : action.kind === 'restore' ? 'Restore this review?' : action.how === 'HIDE_REVIEW' ? 'Hide the reported review?' : 'Keep the review public?';
  const body = !action ? '' : action.kind === 'hide' || (action.kind === 'resolve' && action.how === 'HIDE_REVIEW')
    ? 'It disappears from the salon page, the salon\'s dashboard and the rating average. The author still sees it, with your reason.'
    : action.kind === 'restore' ? 'It becomes public again and counts in the rating average.' : 'The report is closed and the review stays public. The salon owner sees your decision.';

  return (
    <dialog ref={ref} aria-label={title} onCancel={(e) => { e.preventDefault(); if (!run.isPending) onClose(); }}
      className="m-auto w-[min(92vw,30rem)] rounded-sheet border border-line bg-surface p-6 text-fg shadow-soft backdrop:bg-black/40">
      <h2 className="text-xl">{title}</h2>
      <p className="mt-2 text-sm text-muted">{body}</p>
      {action && action.kind !== 'restore' && (
        <div className="mt-4">
          <TextArea label={needsReason ? (noteOptional ? 'Note (optional)' : 'Reason (shown to the author)') : 'Note (optional)'} value={text} maxLength={300}
            onChange={(e) => setText(e.target.value)} onBlur={() => setTouched(true)}
            error={touched && blocked ? (reasonError(text) ?? undefined) : undefined} />
        </div>
      )}
      {err && <p role="alert" className="mt-3 text-sm text-danger">{err.message}{err.requestId ? ` (ref ${err.requestId})` : ''}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={run.isPending}>Cancel</Button>
        <Button variant={needsReason ? 'destructive' : 'primary'} loading={run.isPending} disabled={blocked} onClick={() => run.mutate()}>
          {action?.kind === 'restore' ? 'Restore' : needsReason ? 'Hide review' : 'Confirm'}
        </Button>
      </div>
    </dialog>
  );
}

/** Phase 14: review moderation. Support can read; only Super Admin can hide, restore or resolve (the API enforces it, the buttons follow). */
export function ReviewsPage() {
  const { user } = useAuth();
  const canModerate = user?.role === 'SUPER_ADMIN';
  const [tab, setTab] = useState<Tab>('reports');
  const [page, setPage] = useState(1);
  const [action, setAction] = useState<Action | null>(null);

  const counts = useQuery({ queryKey: ['review-counts'], queryFn: () => apiFetch<Counts>('/admin/reviews/overview'), refetchInterval: 60_000 });
  const path = tab === 'reports' ? `/admin/reviews/reports?status=OPEN&page=${page}&pageSize=20`
    : tab === 'hidden' ? `/admin/reviews?status=HIDDEN&page=${page}&pageSize=20` : `/admin/reviews?page=${page}&pageSize=20`;
  const list = useQuery({
    queryKey: ['reviews', tab, page],
    queryFn: () => apiFetch<Paged<AdminReview | AdminReport>>(path),
  });
  const pages = list.data ? pagesOf(list.data.total, list.data.pageSize) : 1;

  return (
    <div>
      <h1 className="text-4xl">Reviews</h1>
      <p className="mt-1 text-muted">Customer reviews of salons. You can hide a review that breaks the rules; you never edit what a customer wrote.</p>
      {counts.data && <p className="mt-3 text-sm text-muted">{counts.data.openReports} open report(s) · {counts.data.hidden} hidden · {counts.data.published} published</p>}

      <div role="tablist" aria-label="Review lists" className="mt-6 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button key={t.key} role="tab" type="button" aria-selected={tab === t.key} onClick={() => { setTab(t.key); setPage(1); }}
            className={`min-h-11 rounded-input px-4 text-sm font-medium transition-colors ${tab === t.key ? 'bg-ink text-ivory dark:bg-gold dark:text-ink' : 'border border-line bg-surface hover:bg-sand'}`}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="mt-4 space-y-4">
        {list.isLoading ? <><Skeleton className="h-36" /><Skeleton className="h-36" /></>
          : list.error ? <Card><ErrorState message={(list.error as ApiError).message} requestId={(list.error as ApiError).requestId} onRetry={() => void list.refetch()} /></Card>
          : (list.data?.items.length ?? 0) === 0 ? <Card><EmptyState title={tab === 'reports' ? 'No open reports' : tab === 'hidden' ? 'No hidden reviews' : 'No reviews yet'} message={tab === 'reports' ? 'When a salon reports a review it appears here.' : 'Reviews written by customers appear here.'} /></Card>
          : tab === 'reports'
            ? (list.data!.items as AdminReport[]).map((r) => <ReportCard key={r.id} r={r} canModerate={canModerate} onAction={setAction} />)
            : (list.data!.items as AdminReview[]).map((r) => <ReviewCard key={r.id} r={r} canModerate={canModerate} onAction={setAction} />)}
      </div>

      {list.data && list.data.total > list.data.pageSize && (
        <div className="mt-4 flex items-center justify-between text-sm">
          <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <span>Page {page} of {pages}</span>
          <Button variant="secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      )}
      <DecisionDialog action={action} onClose={() => setAction(null)} />
    </div>
  );
}
