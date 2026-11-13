import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Button, Card, ConfirmDialog, ErrorState, Input, Skeleton } from '../../design-system';
import { ApiError, apiFetch, apiJson } from '../../lib/api';
import { useAuth } from '../auth/AuthContext';
import { METHOD_LABEL, MethodKind, PayMethod, Plan, Promotion, day, pkr, when } from './types';
import { Pill, Select, TextArea } from './ui';

const MONEY = /^\d{1,8}(\.\d{1,2})?$/;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const errText = (e: unknown) => (e instanceof ApiError ? e.message : null);

export function BillingSettingsPage() {
  const { user } = useAuth();
  const isSuper = user?.role === 'SUPER_ADMIN';
  return (
    <div>
      <h1 className="text-4xl">Billing settings</h1>
      <p className="mt-1 text-muted">Prices, promotions and where owners send their payments. {isSuper ? 'Every change is recorded in the audit log.' : 'Read-only: only a Super Admin can change these.'}</p>
      <PlanSection isSuper={isSuper} />
      <DiscoverySection isSuper={isSuper} />
      <PromotionsSection isSuper={isSuper} />
      <MethodsSection isSuper={isSuper} />
    </div>
  );
}

// ---------------------------------------------------------------------------- price plan
function PlanSection({ isSuper }: { isSuper: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['billing-plans'], queryFn: () => apiFetch<{ current: Plan | null; history: Plan[] }>('/admin/billing/plans') });
  const [f, setF] = useState({ monthly: '', yearly: '', grace: '3', notice: '7', note: '' });
  const [confirm, setConfirm] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: () => apiJson('/admin/billing/plans', 'POST', { monthlyPricePerStaff: f.monthly.trim(), yearlyPricePerStaff: f.yearly.trim(), graceDays: Number(f.grace), renewalNoticeDays: Number(f.notice), ...(f.note.trim() ? { note: f.note.trim() } : {}) }),
    onSuccess: () => { setConfirm(false); setF({ monthly: '', yearly: '', grace: f.grace, notice: f.notice, note: '' }); void qc.invalidateQueries({ queryKey: ['billing-plans'] }); },
  });
  function review(e: FormEvent) {
    e.preventDefault();
    const er: Record<string, string> = {};
    if (!MONEY.test(f.monthly.trim()) || Number(f.monthly) < 1) er.monthly = 'Enter an amount like 300 or 300.50.';
    if (!MONEY.test(f.yearly.trim()) || Number(f.yearly) < 1) er.yearly = 'Enter an amount like 3000.';
    if (!/^\d{1,2}$/.test(f.grace) || Number(f.grace) > 60) er.grace = '0 to 60 days.';
    if (!/^\d{1,2}$/.test(f.notice) || Number(f.notice) < 1 || Number(f.notice) > 60) er.notice = '1 to 60 days.';
    setErrors(er);
    if (Object.keys(er).length === 0) setConfirm(true);
  }
  return (
    <section className="mt-8">
      <h2 className="text-2xl">Subscription price</h2>
      <Card className="mt-3">
        {q.isLoading ? <Skeleton className="h-24" /> : q.error ? <ErrorState message={(q.error as ApiError).message} onRetry={() => void q.refetch()} /> : (
          <>
            {q.data?.current ? (
              <div className="grid gap-4 sm:grid-cols-4">
                <div><p className="text-xs uppercase tracking-wide text-muted">Monthly per staff</p><p className="font-serif text-2xl">{pkr(q.data.current.monthlyPricePerStaff)}</p></div>
                <div><p className="text-xs uppercase tracking-wide text-muted">Yearly per staff</p><p className="font-serif text-2xl">{pkr(q.data.current.yearlyPricePerStaff)}</p></div>
                <div><p className="text-xs uppercase tracking-wide text-muted">Grace period</p><p className="font-serif text-2xl">{q.data.current.graceDays} days</p></div>
                <div><p className="text-xs uppercase tracking-wide text-muted">Renewal opens</p><p className="font-serif text-2xl">{q.data.current.renewalNoticeDays} days before</p></div>
              </div>
            ) : <p className="text-sm text-warning">No price is configured yet. Owners cannot subscribe until you set one.</p>}
            <p className="mt-3 text-sm text-muted">A new price applies to invoices issued from now on. Invoices already issued and running periods keep their locked price.</p>
          </>
        )}
        {isSuper && (
          <form className="mt-6 grid gap-4 border-t border-line pt-6 sm:grid-cols-2" onSubmit={review} noValidate>
            <Input label="Monthly price per staff (Rs.)" inputMode="decimal" value={f.monthly} onChange={(e) => setF({ ...f, monthly: e.target.value })} error={errors.monthly} />
            <Input label="Yearly price per staff (Rs.)" inputMode="decimal" value={f.yearly} onChange={(e) => setF({ ...f, yearly: e.target.value })} error={errors.yearly} />
            <Input label="Grace period (days)" inputMode="numeric" value={f.grace} onChange={(e) => setF({ ...f, grace: e.target.value })} error={errors.grace} />
            <Input label="Renewal opens (days before expiry)" inputMode="numeric" value={f.notice} onChange={(e) => setF({ ...f, notice: e.target.value })} error={errors.notice} />
            <div className="sm:col-span-2"><TextArea label="Note (optional)" value={f.note} maxLength={300} onChange={(e) => setF({ ...f, note: e.target.value })} /></div>
            <div className="sm:col-span-2"><Button type="submit">Set new price</Button></div>
          </form>
        )}
        {q.data && q.data.history.length > 1 && (
          <details className="mt-6 text-sm"><summary className="cursor-pointer font-medium">Price history ({q.data.history.length})</summary>
            <ul className="mt-2 space-y-1">{q.data.history.map((p) => <li key={p.id} className="flex flex-wrap gap-x-3"><span className="text-muted">{when(p.effectiveFrom)}</span><span>{pkr(p.monthlyPricePerStaff)} / month · {pkr(p.yearlyPricePerStaff)} / year · grace {p.graceDays}d</span>{p.note && <span className="text-muted">{p.note}</span>}</li>)}</ul>
          </details>
        )}
      </Card>
      <ConfirmDialog open={confirm} title="Set a new subscription price?" confirmLabel="Set price" loading={save.isPending} onConfirm={() => save.mutate()} onCancel={() => setConfirm(false)}>
        <p>{pkr(Number(f.monthly || 0).toFixed(2))} per staff per month and {pkr(Number(f.yearly || 0).toFixed(2))} per staff per year, effective now. Existing invoices are not changed.</p>
        {errText(save.error) && <p role="alert" className="mt-2 text-danger">{errText(save.error)}</p>}
      </ConfirmDialog>
    </section>
  );
}

// ---------------------------------------------------------------------------- promotions
function PromotionsSection({ isSuper }: { isSuper: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['billing-promotions'], queryFn: () => apiFetch<{ items: Promotion[] }>('/admin/billing/promotions') });
  const [f, setF] = useState({ name: '', percent: '', appliesTo: 'ANY', startsOn: new Date().toISOString().slice(0, 10), endsOn: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const create = useMutation({
    mutationFn: () => apiJson('/admin/billing/promotions', 'POST', { name: f.name.trim(), percentOff: f.percent.trim(), appliesTo: f.appliesTo, startsOn: f.startsOn, ...(f.endsOn ? { endsOn: f.endsOn } : {}) }),
    onSuccess: () => { setF({ ...f, name: '', percent: '', endsOn: '' }); void qc.invalidateQueries({ queryKey: ['billing-promotions'] }); },
  });
  const toggle = useMutation({
    mutationFn: (v: { id: string; isActive: boolean }) => apiJson(`/admin/billing/promotions/${v.id}`, 'PATCH', { isActive: v.isActive }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['billing-promotions'] }),
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    const er: Record<string, string> = {};
    if (f.name.trim().length < 2) er.name = 'Give the promotion a name.';
    if (!/^(?:100(?:\.0{1,2})?|\d{1,2}(?:\.\d{1,2})?)$/.test(f.percent.trim()) || Number(f.percent) <= 0) er.percent = 'Between 0.01 and 100.';
    if (!ISO.test(f.startsOn)) er.startsOn = 'Pick a start date.';
    if (f.endsOn && f.endsOn < f.startsOn) er.endsOn = 'Cannot be before the start date.';
    setErrors(er);
    if (Object.keys(er).length === 0) create.mutate();
  }
  return (
    <section className="mt-10">
      <h2 className="text-2xl">Promotional discounts</h2>
      <p className="text-sm text-muted">The biggest active discount is applied to each new first or renewal invoice and saved on it. One promotion per invoice.</p>
      <Card className="mt-3">
        {q.isLoading ? <Skeleton className="h-16" /> : q.error ? <ErrorState message={(q.error as ApiError).message} onRetry={() => void q.refetch()} /> : q.data && q.data.items.length === 0 ? <p className="text-sm text-muted">No promotions yet.</p> : (
          <ul className="divide-y divide-line">
            {q.data?.items.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                <span><span className="font-semibold">{p.name}</span> · {p.percentOff}% off {p.appliesTo === 'ANY' ? 'any plan' : p.appliesTo.toLowerCase()}<br /><span className="text-xs text-muted">{day(p.startsOn)} to {p.endsOn ? day(p.endsOn) : 'no end date'}</span></span>
                <span className="flex items-center gap-2"><Pill tone={p.isActive ? 'good' : 'muted'}>{p.isActive ? 'Active' : 'Off'}</Pill>
                  {isSuper && <Button variant="secondary" loading={toggle.isPending && toggle.variables?.id === p.id} onClick={() => toggle.mutate({ id: p.id, isActive: !p.isActive })}>{p.isActive ? 'Deactivate' : 'Activate'}</Button>}</span>
              </li>
            ))}
          </ul>
        )}
        {errText(toggle.error) && <p role="alert" className="mt-2 text-sm text-danger">{errText(toggle.error)}</p>}
        {isSuper && (
          <form className="mt-6 grid gap-4 border-t border-line pt-6 sm:grid-cols-2" onSubmit={submit} noValidate>
            <Input label="Name" value={f.name} maxLength={80} onChange={(e) => setF({ ...f, name: e.target.value })} error={errors.name} />
            <Input label="Discount (%)" inputMode="decimal" value={f.percent} onChange={(e) => setF({ ...f, percent: e.target.value })} error={errors.percent} />
            <Select label="Applies to" value={f.appliesTo} onChange={(e) => setF({ ...f, appliesTo: e.target.value })}><option value="ANY">Any plan</option><option value="MONTHLY">Monthly only</option><option value="YEARLY">Yearly only</option></Select>
            <Input label="Starts on" type="date" value={f.startsOn} onChange={(e) => setF({ ...f, startsOn: e.target.value })} error={errors.startsOn} />
            <Input label="Ends on (optional)" type="date" value={f.endsOn} onChange={(e) => setF({ ...f, endsOn: e.target.value })} error={errors.endsOn} />
            <div className="flex items-end"><Button type="submit" loading={create.isPending}>Add promotion</Button></div>
            {errText(create.error) && <p role="alert" className="text-sm text-danger sm:col-span-2">{errText(create.error)}</p>}
          </form>
        )}
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------------------- payment instructions
const emptyMethod = { method: 'JAZZCASH' as MethodKind, accountTitle: '', accountNumber: '', bankName: '', instructions: '' };

function MethodsSection({ isSuper }: { isSuper: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['billing-methods'], queryFn: () => apiFetch<{ items: PayMethod[] }>('/admin/billing/payment-methods') });
  const [f, setF] = useState(emptyMethod);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const refresh = () => void qc.invalidateQueries({ queryKey: ['billing-methods'] });
  const save = useMutation({
    mutationFn: () => editing
      ? apiJson(`/admin/billing/payment-methods/${editing}`, 'PATCH', { accountTitle: f.accountTitle.trim(), accountNumber: f.accountNumber.trim(), bankName: f.bankName.trim() || null, instructions: f.instructions.trim() || null })
      : apiJson('/admin/billing/payment-methods', 'POST', { method: f.method, accountTitle: f.accountTitle.trim(), accountNumber: f.accountNumber.trim(), ...(f.bankName.trim() ? { bankName: f.bankName.trim() } : {}), ...(f.instructions.trim() ? { instructions: f.instructions.trim() } : {}) }),
    onSuccess: () => { setConfirm(false); setEditing(null); setF(emptyMethod); refresh(); },
  });
  const toggle = useMutation({ mutationFn: (v: { id: string; isActive: boolean }) => apiJson(`/admin/billing/payment-methods/${v.id}`, 'PATCH', { isActive: v.isActive }), onSuccess: refresh });

  function review(e: FormEvent) {
    e.preventDefault();
    const er: Record<string, string> = {};
    if (f.accountTitle.trim().length < 2) er.accountTitle = 'Enter the account title.';
    if (f.accountNumber.trim().length < 4) er.accountNumber = 'Enter the account number or IBAN.';
    if (f.method === 'BANK_TRANSFER' && !f.bankName.trim()) er.bankName = 'Bank name is required.';
    setErrors(er);
    if (Object.keys(er).length === 0) setConfirm(true);
  }
  return (
    <section className="mt-10">
      <h2 className="text-2xl">Payment instructions</h2>
      <p className="text-sm text-muted">Owners see only ACTIVE methods. Changing where money is sent is a sensitive action and is always audited.</p>
      <Card className="mt-3">
        {q.isLoading ? <Skeleton className="h-16" /> : q.error ? <ErrorState message={(q.error as ApiError).message} onRetry={() => void q.refetch()} /> : q.data && q.data.items.length === 0 ? <p className="text-sm text-warning">No payment method yet. Owners cannot submit payments until you add one.</p> : (
          <ul className="divide-y divide-line">
            {q.data?.items.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                <span><span className="font-semibold">{METHOD_LABEL[m.method]}</span> · {m.accountTitle}<br /><span className="font-mono text-xs">{m.accountNumber}</span>{m.bankName && <span className="text-xs text-muted"> · {m.bankName}</span>}{m.instructions && <><br /><span className="text-xs text-muted">{m.instructions}</span></>}</span>
                <span className="flex items-center gap-2"><Pill tone={m.isActive ? 'good' : 'muted'}>{m.isActive ? 'Shown to owners' : 'Hidden'}</Pill>
                  {isSuper && <>
                    <Button variant="ghost" onClick={() => { setEditing(m.id); setF({ method: m.method, accountTitle: m.accountTitle, accountNumber: m.accountNumber, bankName: m.bankName ?? '', instructions: m.instructions ?? '' }); }}>Edit</Button>
                    <Button variant="secondary" loading={toggle.isPending && toggle.variables?.id === m.id} onClick={() => toggle.mutate({ id: m.id, isActive: !m.isActive })}>{m.isActive ? 'Hide' : 'Show'}</Button></>}</span>
              </li>
            ))}
          </ul>
        )}
        {errText(toggle.error) && <p role="alert" className="mt-2 text-sm text-danger">{errText(toggle.error)}</p>}
        {isSuper && (
          <form className="mt-6 grid gap-4 border-t border-line pt-6 sm:grid-cols-2" onSubmit={review} noValidate>
            <h3 className="text-lg sm:col-span-2">{editing ? 'Edit payment method' : 'Add a payment method'}</h3>
            <Select label="Method" value={f.method} disabled={editing !== null} onChange={(e) => setF({ ...f, method: e.target.value as MethodKind })}>
              {(Object.keys(METHOD_LABEL) as MethodKind[]).map((k) => <option key={k} value={k}>{METHOD_LABEL[k]}</option>)}
            </Select>
            <Input label="Account title" value={f.accountTitle} maxLength={80} onChange={(e) => setF({ ...f, accountTitle: e.target.value })} error={errors.accountTitle} />
            <Input label={f.method === 'BANK_TRANSFER' ? 'Account number / IBAN' : 'Mobile account number'} value={f.accountNumber} maxLength={40} onChange={(e) => setF({ ...f, accountNumber: e.target.value })} error={errors.accountNumber} />
            {f.method === 'BANK_TRANSFER' && <Input label="Bank name" value={f.bankName} maxLength={80} onChange={(e) => setF({ ...f, bankName: e.target.value })} error={errors.bankName} />}
            <div className="sm:col-span-2"><TextArea label="Instructions shown to owners (optional)" value={f.instructions} maxLength={500} onChange={(e) => setF({ ...f, instructions: e.target.value })} /></div>
            <div className="flex gap-2 sm:col-span-2"><Button type="submit">{editing ? 'Review changes' : 'Add method'}</Button>{editing && <Button type="button" variant="ghost" onClick={() => { setEditing(null); setF(emptyMethod); }}>Cancel edit</Button>}</div>
          </form>
        )}
      </Card>
      <ConfirmDialog open={confirm} title={editing ? 'Change where owners send money?' : 'Add this payment method?'} confirmLabel={editing ? 'Save changes' : 'Add'} destructive={editing !== null} loading={save.isPending} onConfirm={() => save.mutate()} onCancel={() => setConfirm(false)}>
        <p>Check the account number carefully: owners will send real money here. {METHOD_LABEL[f.method]} · {f.accountTitle.trim()} · {f.accountNumber.trim()}</p>
        {errText(save.error) && <p role="alert" className="mt-2 text-danger">{errText(save.error)}</p>}
      </ConfirmDialog>
    </section>
  );
}

// ---------------------------------------------------------------------------- public listing: free trial (Phase 7)
interface DiscoverySettings { trialDays: number; defaultTrialDays: number; maxTrialDays: number }

function DiscoverySection({ isSuper }: { isSuper: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['discovery-settings'], queryFn: () => apiFetch<DiscoverySettings>('/admin/discovery/settings') });
  const [days, setDays] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [confirm, setConfirm] = useState(false);
  const save = useMutation({
    mutationFn: () => apiJson('/admin/discovery/settings', 'PUT', { trialDays: Number(days) }),
    onSuccess: () => { setConfirm(false); setDays(''); void qc.invalidateQueries({ queryKey: ['discovery-settings'] }); },
  });
  function review(e: FormEvent) {
    e.preventDefault();
    const max = q.data?.maxTrialDays ?? 90;
    if (!/^\d{1,2}$/.test(days.trim()) || Number(days) > max) { setError(`Whole days from 0 to ${max}.`); return; }
    setError(undefined);
    setConfirm(true);
  }
  return (
    <section className="mt-8">
      <h2 className="text-2xl">Free trial in public search</h2>
      <Card className="mt-3">
        {q.isLoading ? <Skeleton className="h-16" /> : q.error ? <ErrorState message={(q.error as ApiError).message} onRetry={() => void q.refetch()} /> : (
          <>
            <p className="text-sm text-muted">A newly approved salon is shown to customers for this many days. After that it is listed only while its subscription is active or in its grace period. Salons that already subscribed are not affected.</p>
            <p className="mt-3 font-serif text-2xl">{q.data?.trialDays} {q.data?.trialDays === 1 ? 'day' : 'days'}</p>
          </>
        )}
        {isSuper && (
          <form className="mt-6 flex flex-wrap items-end gap-4 border-t border-line pt-6" onSubmit={review} noValidate>
            <div className="w-48"><Input label="Trial length (days)" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} error={error} /></div>
            <Button type="submit">Change trial length</Button>
          </form>
        )}
      </Card>
      <ConfirmDialog open={confirm} title="Change the free trial length?" confirmLabel="Change" loading={save.isPending} onConfirm={() => save.mutate()} onCancel={() => setConfirm(false)}>
        <p>New trial length: {days} days. It applies immediately to every salon that has never subscribed: salons whose trial would already be over disappear from search.</p>
        {errText(save.error) && <p role="alert" className="mt-2 text-danger">{errText(save.error)}</p>}
      </ConfirmDialog>
    </section>
  );
}
