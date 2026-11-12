import type { ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { useId } from 'react';
import { PAYMENT_LABEL, PHASE_LABEL, PaymentStatus, Phase } from './types';

const TONE: Record<string, string> = {
  good: 'bg-emerald/15 text-emerald',
  warn: 'bg-warning/15 text-warning',
  bad: 'bg-danger/15 text-danger',
  info: 'bg-info/15 text-info',
  muted: 'bg-sand text-muted',
};

export function Pill({ tone, children }: { tone: keyof typeof TONE; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${TONE[tone]}`}>{children}</span>;
}

export const PhasePill = ({ phase }: { phase: Phase }) => (
  <Pill tone={phase === 'ACTIVE' ? 'good' : phase === 'GRACE' ? 'warn' : phase === 'EXPIRED' ? 'bad' : phase === 'SUSPENDED' ? 'muted' : 'info'}>{PHASE_LABEL[phase]}</Pill>
);

export const PaymentPill = ({ status }: { status: PaymentStatus }) => (
  <Pill tone={status === 'APPROVED' ? 'good' : status === 'REJECTED' ? 'bad' : 'warn'}>{PAYMENT_LABEL[status]}</Pill>
);

const FIELD = 'w-full rounded-input border border-line bg-surface px-4 text-sm outline-none transition-colors focus:border-gold focus:ring-1 focus:ring-gold';

export function TextArea({ label, error, hint, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; error?: string; hint?: string }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">{label}</label>
      <textarea id={id} rows={3} aria-invalid={error ? true : undefined} className={`${FIELD} py-3 ${error ? 'border-danger' : ''}`} {...rest} />
      {error ? <p role="alert" className="mt-1.5 text-sm text-danger">{error}</p> : hint ? <p className="mt-1.5 text-sm text-muted">{hint}</p> : null}
    </div>
  );
}

export function Select({ label, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { label: string }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">{label}</label>
      <select id={id} className={`${FIELD} min-h-11`} {...rest}>{children}</select>
    </div>
  );
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 sm:flex-row sm:items-baseline sm:gap-4">
      <dt className="w-44 shrink-0 text-sm text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-sm font-medium">{children}</dd>
    </div>
  );
}
