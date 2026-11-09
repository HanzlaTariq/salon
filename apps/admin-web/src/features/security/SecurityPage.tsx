import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Button, Card, EmptyState, ErrorState, Input, Skeleton } from '../../design-system';
import { ApiError, apiFetch, apiJson } from '../../lib/api';
import { useAuth } from '../auth/AuthContext';
import { FormError } from '../auth/AuthLayout';

interface SessionRow {
  id: string;
  createdAt: string;
  lastUsedAt: string;
  userAgent: string | null;
  ipAddress: string | null;
  current: boolean;
}

const errMsg = (e: unknown) => (e instanceof ApiError ? e : null);

function MfaCard() {
  const { user, mfaEnrollmentRequired, reloadSession } = useAuth();
  const [step, setStep] = useState<'idle' | 'verify' | 'codes'>('idle');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [recovery, setRecovery] = useState<string[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  async function start(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setSetup(await apiJson('/auth/mfa/setup', 'POST', { password }));
      setPassword('');
      setStep('verify');
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  async function enable(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await apiJson<{ recoveryCodes: string[] }>('/auth/mfa/enable', 'POST', { code: code.trim() });
      setRecovery(r.recoveryCodes);
      setSetup(null);
      setCode('');
      setStep('codes');
      await reloadSession();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="text-2xl">Two-factor authentication</h2>
      {mfaEnrollmentRequired && (
        <p role="alert" className="mt-3 rounded-input border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
          Two-factor authentication is mandatory for administrators. Finish setup to continue.
        </p>
      )}
      <FormError message={error?.message} />
      {step === 'codes' ? (
        <div className="mt-4">
          <p className="text-sm">Two-factor authentication is on. Save these recovery codes now; each works once and they will not be shown again.</p>
          <ul className="mt-3 grid grid-cols-1 gap-2 font-mono text-sm sm:grid-cols-2">
            {recovery.map((c) => (
              <li key={c} className="rounded-input bg-sand px-3 py-2">{c}</li>
            ))}
          </ul>
          <div className="mt-4 flex gap-2">
            <Button variant="secondary" onClick={() => void navigator.clipboard?.writeText(recovery.join('\n'))}>Copy codes</Button>
            <Button onClick={() => { setRecovery([]); setStep('idle'); }}>I saved them</Button>
          </div>
        </div>
      ) : user?.mfaEnabled ? (
        <p className="mt-3 text-sm text-muted">Enabled. You will be asked for a code each time you sign in.</p>
      ) : step === 'verify' && setup ? (
        <form onSubmit={enable} className="mt-4 space-y-4" noValidate>
          <p className="text-sm">Scan this QR code with an authenticator app (Google Authenticator, Authy, 1Password), then enter the 6-digit code.</p>
          <div className="inline-block rounded-card bg-white p-3">
            <QRCodeSVG value={setup.otpauthUri} size={168} title="Authenticator QR code" />
          </div>
          <p className="break-all text-xs text-muted">Can’t scan? Enter this key manually: <span className="font-mono">{setup.secret}</span></p>
          <Input label="6-digit code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} />
          <Button type="submit" loading={busy} disabled={code.trim().length !== 6}>Turn on</Button>
        </form>
      ) : (
        <form onSubmit={start} className="mt-4 space-y-4" noValidate>
          <p className="text-sm text-muted">Confirm your password to begin setup.</p>
          <Input label="Current password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <Button type="submit" loading={busy} disabled={!password}>Set up two-factor</Button>
        </form>
      )}
    </Card>
  );
}

function PasswordCard() {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [done, setDone] = useState(false);
  const m = useMutation({
    mutationFn: () => apiJson('/auth/change-password', 'POST', { currentPassword: cur, newPassword: next }),
    onSuccess: () => {
      setCur('');
      setNext('');
      setDone(true);
    },
  });
  const err = errMsg(m.error);
  return (
    <Card>
      <h2 className="text-2xl">Change password</h2>
      <form
        className="mt-4 space-y-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setDone(false);
          m.mutate();
        }}
      >
        <FormError message={err?.message} details={err?.body.details} />
        {done && <p role="status" className="text-sm text-emerald">Password changed. Other devices were signed out.</p>}
        <Input label="Current password" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} />
        <Input label="New password" type="password" autoComplete="new-password" hint="At least 10 characters." value={next} onChange={(e) => setNext(e.target.value)} />
        <Button type="submit" loading={m.isPending} disabled={!cur || !next}>Update password</Button>
      </form>
    </Card>
  );
}

function SessionsCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['sessions'], queryFn: () => apiFetch<SessionRow[]>('/auth/sessions') });
  const revoke = useMutation({
    mutationFn: (id: string) => apiJson('/auth/sessions/' + id, 'DELETE'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
  });
  const all = useMutation({
    mutationFn: () => apiJson('/auth/logout-all', 'POST', { keepCurrent: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
  });
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-2xl">Active sessions</h2>
        <Button variant="secondary" loading={all.isPending} onClick={() => all.mutate()}>Sign out other devices</Button>
      </div>
      <div className="mt-4">
        {q.isLoading ? (
          <Skeleton className="h-20" />
        ) : q.error ? (
          <ErrorState message={(q.error as ApiError).message} onRetry={() => void q.refetch()} />
        ) : q.data && q.data.length > 0 ? (
          <ul className="divide-y divide-line">
            {q.data.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                <div className="min-w-0">
                  <p className="break-words font-medium">{s.userAgent ?? 'Unknown device'}{s.current && <span className="ml-2 text-emerald">(this device)</span>}</p>
                  <p className="text-muted">{s.ipAddress ?? 'IP unknown'} · last active {new Date(s.lastUsedAt).toLocaleString()}</p>
                </div>
                {!s.current && <Button variant="ghost" onClick={() => revoke.mutate(s.id)} loading={revoke.isPending && revoke.variables === s.id}>Revoke</Button>}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No other sessions" />
        )}
      </div>
    </Card>
  );
}

export function SecurityPage() {
  return (
    <div>
      <h1 className="text-4xl">Security</h1>
      <p className="mt-1 text-muted">Protect your administrator account.</p>
      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <MfaCard />
        <PasswordCard />
        <div className="lg:col-span-2"><SessionsCard /></div>
      </div>
    </div>
  );
}
