import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Button, Input, Skeleton } from '../../design-system';
import { ApiError, apiFetch, apiJson } from '../../lib/api';
import { METHOD_LABEL, PaymentDetail, day, KIND_LABEL, pkr, when } from './types';
import { PaymentPill, Row, TextArea } from './ui';

type Mode = null | 'approve' | 'reject' | 'info';

/** "600" and "600.0" both mean Rs. 600.00: compared as text, never as floats. */
const norm = (v: string): string => {
  const t = v.trim();
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(t)) return '';
  const [w, f = ''] = t.split('.');
  return `${w}.${f.padEnd(2, '0')}`;
};

const ACTION_LABEL: Record<string, string> = {
  'payment.submitted': 'Submitted by the owner', 'payment.info_requested': 'More information requested', 'payment.info_provided': 'Owner answered',
  'payment.approved': 'Approved', 'payment.rejected': 'Rejected', 'payment.receipt_viewed': 'Receipt viewed',
};

/**
 * Manual payment verification. The reviewer opens the receipt, compares it with the bank / wallet statement and
 * must TYPE the amount received: the server only approves when it equals the invoice total.
 */
export function PaymentReviewDialog({ paymentId, onClose }: { paymentId: string | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>(null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [showReceipt, setShowReceipt] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (paymentId && !d.open) d.showModal();
    if (!paymentId && d.open) d.close();
    setMode(null); setAmount(''); setReason(''); setShowReceipt(false);
  }, [paymentId]);

  const q = useQuery({ queryKey: ['payment', paymentId], enabled: paymentId !== null, queryFn: () => apiFetch<PaymentDetail>(`/admin/payments/${paymentId}`) });
  const receipt = useQuery({
    queryKey: ['payment-receipt', paymentId], enabled: paymentId !== null && showReceipt, staleTime: 0, gcTime: 0,
    queryFn: () => apiFetch<{ url: string; expiresInSec: number }>(`/admin/payments/${paymentId}/receipt-url`),
  });

  const decide = useMutation({
    mutationFn: (v: { path: 'approve' | 'reject' | 'request-info'; body: object }) => apiJson<PaymentDetail>(`/admin/payments/${paymentId}/${v.path}`, 'POST', v.body),
    onSuccess: (data) => {
      qc.setQueryData(['payment', paymentId], data);
      void qc.invalidateQueries({ queryKey: ['payments'] });
      void qc.invalidateQueries({ queryKey: ['billing-overview'] });
      void qc.invalidateQueries({ queryKey: ['subscriptions'] });
      setMode(null); setAmount(''); setReason('');
    },
  });

  const d = q.data;
  const p = d?.payment;
  const err = decide.error instanceof ApiError ? decide.error : null;
  const canApprove = p?.status === 'PENDING';
  const canQuery = p?.status === 'PENDING';
  const canReject = p?.status === 'PENDING' || p?.status === 'NEEDS_INFO';
  const amountOk = p ? norm(amount) === norm(p.invoice.total) : false;

  return (
    <dialog
      ref={ref}
      onCancel={(e) => { e.preventDefault(); if (!decide.isPending) onClose(); }}
      aria-label="Verify payment"
      className="m-auto max-h-[92vh] w-[min(96vw,44rem)] overflow-y-auto rounded-sheet border border-line bg-surface p-5 text-fg shadow-soft backdrop:bg-black/50"
    >
      {q.isLoading && <div className="space-y-3"><Skeleton className="h-8 w-56" /><Skeleton className="h-40" /></div>}
      {q.error && <p role="alert" className="text-danger">{(q.error as ApiError).message}</p>}
      {p && d && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-2xl">{p.salon.name}</h2>
            <PaymentPill status={p.status} />
          </div>
          <p className="text-sm text-muted">{p.salon.city} · {d.owner ? `${d.owner.name} (${d.owner.email})` : 'owner unknown'}</p>

          <dl className="mt-4 divide-y divide-line rounded-input border border-line px-4">
            <Row label="Invoice">{p.invoice.invoiceNo} · {KIND_LABEL[p.invoice.kind] ?? p.invoice.kind}</Row>
            <Row label="Amount due"><span className="font-serif text-xl">{pkr(p.invoice.total)}</span></Row>
            <Row label="Method">{METHOD_LABEL[p.method]}</Row>
            <Row label="Transaction ID"><span className="font-mono">{p.transactionId}</span></Row>
            <Row label="Paid on">{day(p.paidOn)}</Row>
            <Row label="Sender name">{p.senderName ?? '-'}</Row>
            <Row label="Owner's note">{p.note ?? '-'}</Row>
            <Row label="Submitted">{when(p.submittedAt)}</Row>
            {p.reviewReason && <Row label="Last review note">{p.reviewReason}</Row>}
            {p.receivedAmount && <Row label="Received (confirmed)">{pkr(p.receivedAmount)}</Row>}
          </dl>

          <div className="mt-4">
            {!showReceipt ? (
              <Button variant="secondary" onClick={() => setShowReceipt(true)}>View receipt</Button>
            ) : receipt.isLoading ? <Skeleton className="h-48" /> : receipt.error ? (
              <p role="alert" className="text-sm text-danger">{(receipt.error as ApiError).message}</p>
            ) : receipt.data ? (
              <div>
                <img src={receipt.data.url} alt="Payment receipt" referrerPolicy="no-referrer" className="max-h-[60vh] max-w-full rounded-input border border-line object-contain" />
                <p className="mt-2 text-xs text-muted">This link expires in a few minutes. Opening a receipt is recorded in the audit log.</p>
              </div>
            ) : null}
          </div>

          {(canApprove || canQuery || canReject) && mode === null && (
            <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              {canApprove && <Button onClick={() => setMode('approve')}>Approve</Button>}
              {canQuery && <Button variant="secondary" onClick={() => setMode('info')}>Ask for more information</Button>}
              {canReject && <Button variant="destructive" onClick={() => setMode('reject')}>Reject</Button>}
            </div>
          )}

          {mode === 'approve' && (
            <form className="mt-6 space-y-3" onSubmit={(e) => { e.preventDefault(); if (amountOk) decide.mutate({ path: 'approve', body: { receivedAmount: norm(amount) } }); }}>
              <p className="text-sm text-muted">Check the receipt against your JazzCash / Easypaisa / bank statement. Type the amount that actually arrived. It must equal the invoice total ({pkr(p.invoice.total)}).</p>
              <Input label="Amount received (Rs.)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus
                error={amount && !amountOk ? `Must equal ${pkr(p.invoice.total)}` : undefined} />
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button type="button" variant="ghost" onClick={() => setMode(null)} disabled={decide.isPending}>Back</Button>
                <Button type="submit" loading={decide.isPending} disabled={!amountOk}>Confirm approval</Button>
              </div>
            </form>
          )}

          {(mode === 'reject' || mode === 'info') && (
            <form className="mt-6 space-y-3" onSubmit={(e) => { e.preventDefault(); if (reason.trim().length >= 10) decide.mutate({ path: mode === 'reject' ? 'reject' : 'request-info', body: { reason: reason.trim() } }); }}>
              <TextArea label={mode === 'reject' ? 'Reason for rejection (the owner sees this)' : 'What do you need from the owner?'} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)}
                hint="At least 10 characters." />
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button type="button" variant="ghost" onClick={() => setMode(null)} disabled={decide.isPending}>Back</Button>
                <Button type="submit" variant={mode === 'reject' ? 'destructive' : 'primary'} loading={decide.isPending} disabled={reason.trim().length < 10}>
                  {mode === 'reject' ? 'Reject payment' : 'Send request'}
                </Button>
              </div>
            </form>
          )}

          {err && <p role="alert" className="mt-3 text-sm text-danger">{err.message}{err.requestId ? ` (ref ${err.requestId})` : ''}</p>}

          {d.history.length > 0 && (
            <div className="mt-6">
              <h3 className="text-lg">History</h3>
              <ul className="mt-2 space-y-1 text-sm">
                {d.history.map((h, i) => (
                  <li key={i} className="flex flex-wrap gap-x-2"><span className="text-muted">{when(h.at)}</span><span>{ACTION_LABEL[h.action] ?? h.action}{h.reason ? `: ${h.reason}` : ''}</span></li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      <div className="mt-6 flex justify-end"><Button variant="secondary" onClick={onClose} disabled={decide.isPending}>Close</Button></div>
    </dialog>
  );
}
