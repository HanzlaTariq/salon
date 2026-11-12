import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button, Card, ConfirmDialog, ErrorState, ResponsiveTable, Skeleton } from '../../design-system';
import type { Column } from '../../design-system';
import { ApiError, apiFetch, apiJson } from '../../lib/api';
import { useAuth } from '../auth/AuthContext';
import { Cycle, Invoice, KIND_LABEL, METHOD_LABEL, SalonSubscription, day, pkr, when } from './types';
import { PaymentPill, PhasePill, Pill, Row, Select, TextArea } from './ui';

type Action = null | { kind: 'suspend' | 'reactivate' | 'grant' } | { kind: 'void'; invoice: Invoice };
const CREDIT_LABEL: Record<string, string> = {
  STAFF_REMOVED: 'Staff removed mid-period', APPLIED_TO_INVOICE: 'Used on an invoice', INVOICE_VOIDED: 'Invoice cancelled', STALE_TOPUP_PAYMENT: 'Top-up paid after the period changed',
};

export function SubscriptionDetailPage() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const qc = useQueryClient();
  const isSuper = user?.role === 'SUPER_ADMIN';
  const [action, setAction] = useState<Action>(null);
  const [reason, setReason] = useState('');
  const [cycle, setCycle] = useState<Cycle>('MONTHLY');
  const [formError, setFormError] = useState<string | null>(null);

  const q = useQuery({ queryKey: ['salon-subscription', id], queryFn: () => apiFetch<SalonSubscription>(`/admin/salons/${id}/subscription`) });
  const run = useMutation({
    mutationFn: (v: { path: string; body: object }) => apiJson<SalonSubscription>(v.path, 'POST', v.body),
    onSuccess: (data) => {
      qc.setQueryData(['salon-subscription', id], data);
      void qc.invalidateQueries({ queryKey: ['subscriptions'] });
      void qc.invalidateQueries({ queryKey: ['billing-overview'] });
      close();
    },
  });
  function close() { setAction(null); setReason(''); setFormError(null); }

  if (q.isLoading) return <div className="space-y-4"><Skeleton className="h-10 w-64" /><Skeleton className="h-48" /><Skeleton className="h-48" /></div>;
  if (q.error) {
    const e = q.error as ApiError;
    return (
      <div>
        <Link to="/subscriptions" className="inline-flex items-center gap-2 text-sm text-muted hover:underline"><ArrowLeft className="size-4" aria-hidden />Back to subscriptions</Link>
        <Card className="mt-4"><ErrorState message={e.status === 404 ? 'This salon does not exist.' : e.message} requestId={e.requestId} onRetry={() => void q.refetch()} /></Card>
      </div>
    );
  }
  const d = q.data!;
  const sub = d.subscription;
  const err = run.error instanceof ApiError ? run.error : null;

  function submit() {
    if (!action) return;
    const r = reason.trim();
    if (action.kind !== 'reactivate' && r.length < 5) return setFormError('Enter a reason of at least 5 characters.');
    if (action.kind === 'reactivate' && r.length < 5) return setFormError('Enter a short note of at least 5 characters.');
    setFormError(null);
    if (action.kind === 'suspend') run.mutate({ path: `/admin/salons/${id}/subscription/suspend`, body: { reason: r } });
    if (action.kind === 'reactivate') run.mutate({ path: `/admin/salons/${id}/subscription/reactivate`, body: { reason: r } });
    if (action.kind === 'grant') run.mutate({ path: `/admin/salons/${id}/subscription/grant`, body: { cycle, reason: r } });
    if (action.kind === 'void') run.mutate({ path: `/admin/invoices/${action.invoice.id}/void`, body: { reason: r } });
  }

  const invoiceCols: Column<Invoice>[] = [
    { key: 'no', header: 'Invoice', primary: true, cell: (i) => <span className="font-semibold">{i.invoiceNo}<br /><span className="text-xs font-normal text-muted">{KIND_LABEL[i.kind] ?? i.kind}</span></span> },
    { key: 'staff', header: 'Staff', cell: (i) => i.staffCount },
    { key: 'total', header: 'Total', cell: (i) => <span>{pkr(i.total)}{i.creditApplied !== '0.00' && <><br /><span className="text-xs text-muted">credit {pkr(i.creditApplied)}</span></>}{i.proration && <><br /><span className="text-xs text-muted">{i.proration.remainingDays}/{i.proration.totalDays} days</span></>}</span> },
    { key: 'period', header: 'Period', cell: (i) => (i.periodStart ? `${day(i.periodStart)} to ${day(i.periodEnd)}` : '-') },
    { key: 'status', header: 'Status', cell: (i) => <span><Pill tone={i.status === 'PAID' ? 'good' : i.status === 'VOID' ? 'muted' : 'warn'}>{i.status === 'OPEN' ? 'Open' : i.status === 'PAID' ? 'Paid' : 'Void'}</Pill>{i.paymentStatus && <><br /><span className="mt-1 inline-block"><PaymentPill status={i.paymentStatus} /></span></>}</span> },
    { key: 'issued', header: 'Issued', cell: (i) => when(i.issuedAt) },
    { key: 'act', header: '', cell: (i) => (isSuper && i.status === 'OPEN' && !i.paymentStatus ? <Button variant="secondary" onClick={() => setAction({ kind: 'void', invoice: i })}>Void</Button> : null) },
  ];

  return (
    <div>
      <Link to="/subscriptions" className="inline-flex items-center gap-2 text-sm text-muted hover:underline"><ArrowLeft className="size-4" aria-hidden />Back to subscriptions</Link>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="text-4xl">{d.salon.name}</h1>
        <PhasePill phase={sub.phase} />
      </div>
      <p className="mt-1 text-sm text-muted">{d.salon.city} · <Link className="underline" to={`/salons/${d.salon.id}`}>salon details</Link></p>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="text-2xl">Subscription</h2>
          <dl className="mt-2 divide-y divide-line">
            <Row label="Plan">{sub.billingCycle ? sub.billingCycle.toLowerCase() : 'No subscription yet'}</Row>
            <Row label="Current period">{sub.periodStart ? `${day(sub.periodStart)} to ${day(sub.paidThrough)}` : '-'}</Row>
            <Row label="Grace until">{sub.accessThrough && sub.graceDays > 0 ? `${day(sub.accessThrough)} (${sub.graceDays} days)` : '-'}</Row>
            <Row label="Staff covered / billable now">{sub.coveredStaff} / {d.billableStaff}</Row>
            <Row label="Locked price per staff">{sub.unitPrice ? `${pkr(sub.unitPrice)}${sub.discountPercent ? ` (-${sub.discountPercent}%)` : ''}` : '-'}</Row>
            <Row label="Credit balance">{pkr(d.creditBalance)}</Row>
            {sub.suspendedReason && <Row label="Suspended because">{sub.suspendedReason}</Row>}
          </dl>
          {isSuper && (
            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              {sub.phase !== 'NONE' && sub.phase !== 'SUSPENDED' && <Button variant="destructive" onClick={() => setAction({ kind: 'suspend' })}>Suspend subscription</Button>}
              {sub.phase === 'SUSPENDED' && <Button onClick={() => setAction({ kind: 'reactivate' })}>Reactivate</Button>}
              {d.salon.status !== 'REJECTED' && <Button variant="secondary" onClick={() => setAction({ kind: 'grant' })}>Grant complimentary period</Button>}
            </div>
          )}
          {!isSuper && <p className="mt-4 text-sm text-muted">Only a Super Admin can suspend, reactivate or grant a subscription.</p>}
        </Card>

        <Card>
          <h2 className="text-2xl">Staff count history</h2>
          <p className="text-sm text-muted">Snapshots taken whenever the billable team size or an invoice changes.</p>
          {d.staffHistory.length === 0 ? <p className="mt-3 text-sm text-muted">No snapshots yet.</p> : (
            <ul className="mt-3 space-y-1 text-sm">
              {d.staffHistory.map((s, i) => <li key={i} className="flex flex-wrap gap-x-3"><span className="text-muted">{when(s.createdAt)}</span><span>{s.billableStaff} billable{s.coveredStaff !== null ? `, ${s.coveredStaff} covered` : ''}</span><span className="text-muted">{s.reason.toLowerCase().replace('_', ' ')}</span></li>)}
            </ul>
          )}
        </Card>
      </div>

      <h2 className="mt-8 text-2xl">Invoices</h2>
      <Card className="mt-3 p-0 sm:p-2"><ResponsiveTable columns={invoiceCols} rows={d.invoices} rowKey={(i) => i.id} emptyTitle="No invoices yet" emptyMessage="Invoices appear when the owner subscribes or the team size changes." /></Card>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <div>
          <h2 className="text-2xl">Payments</h2>
          <Card className="mt-3">
            {d.payments.length === 0 ? <p className="text-sm text-muted">No payments submitted.</p> : (
              <ul className="divide-y divide-line">
                {d.payments.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                    <span>{pkr(p.amount)} · {METHOD_LABEL[p.method]}<br /><span className="font-mono text-xs text-muted">{p.transactionId}</span></span>
                    <PaymentPill status={p.status} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <div>
          <h2 className="text-2xl">Credits</h2>
          <Card className="mt-3">
            {d.credits.length === 0 ? <p className="text-sm text-muted">No credit movements.</p> : (
              <ul className="divide-y divide-line">
                {d.credits.map((c) => <li key={c.id} className="flex flex-wrap justify-between gap-2 py-3 text-sm"><span>{CREDIT_LABEL[c.reason] ?? c.reason}<br /><span className="text-xs text-muted">{when(c.createdAt)}{c.note ? ` · ${c.note}` : ''}</span></span><span className="font-semibold">{pkr(c.amount)}</span></li>)}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={action !== null}
        title={action?.kind === 'suspend' ? 'Suspend this subscription?' : action?.kind === 'reactivate' ? 'Reactivate this subscription?' : action?.kind === 'grant' ? 'Grant a complimentary period?' : 'Void this invoice?'}
        confirmLabel={action?.kind === 'suspend' ? 'Suspend' : action?.kind === 'reactivate' ? 'Reactivate' : action?.kind === 'grant' ? 'Grant' : 'Void invoice'}
        destructive={action?.kind === 'suspend' || action?.kind === 'void'}
        loading={run.isPending}
        onConfirm={submit}
        onCancel={() => { if (!run.isPending) close(); }}
      >
        <p>
          {action?.kind === 'suspend' && 'The salon stops counting as operational immediately. The owner cannot renew until you reactivate. This is recorded in the audit log.'}
          {action?.kind === 'reactivate' && 'The subscription runs again with its existing dates. Staff changes made meanwhile are billed now.'}
          {action?.kind === 'grant' && 'A free period for the whole salon, however many staff it has. No payment is involved. It is recorded in the audit log with your reason.'}
          {action?.kind === 'void' && `Invoice ${action.invoice.invoiceNo} is cancelled and any credit it used is returned to the salon.`}
        </p>
        {action?.kind === 'grant' && <div className="mt-3"><Select label="Period" value={cycle} onChange={(e) => setCycle(e.target.value as Cycle)}><option value="MONTHLY">One month</option><option value="YEARLY">One year</option></Select></div>}
        <div className="mt-3"><TextArea label="Reason (recorded in the audit log)" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} error={formError ?? undefined} /></div>
        {err && <p role="alert" className="mt-2 text-sm text-danger">{err.message}</p>}
      </ConfirmDialog>
    </div>
  );
}
