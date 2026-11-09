import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Button, Input } from '../../design-system';
import { ApiError, apiJson } from '../../lib/api';
import { AuthLayout, FormError } from './AuthLayout';

/** Reads `#token=...` and immediately removes it from the address bar / history. */
function useFragmentToken(): string | null {
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('token'));
  useEffect(() => {
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
  }, []);
  return token;
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await apiJson('/auth/forgot-password', 'POST', { email: email.trim() });
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="Reset password" subtitle="We will e-mail you a link if the address has an account.">
      {sent ? (
        <p role="status">If an account exists for that address, a reset link is on its way. It expires in 30 minutes.</p>
      ) : (
        <form onSubmit={submit} noValidate className="space-y-4">
          <FormError message={error} />
          <Input label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <Button type="submit" className="w-full" loading={busy} disabled={!email}>
            Send reset link
          </Button>
        </form>
      )}
      <p className="mt-4 text-center text-sm">
        <Link to="/login" className="text-gold-hover underline underline-offset-4">
          Back to sign in
        </Link>
      </p>
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const token = useFragmentToken();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pw !== pw2) {
      setError(new ApiError(0, { code: 'VALIDATION_FAILED', message: 'The two passwords do not match.' }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiJson('/auth/reset-password', 'POST', { token, newPassword: pw });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, { code: 'UNKNOWN', message: 'Something went wrong.' }));
    } finally {
      setBusy(false);
    }
  }

  if (!token && !done) {
    return (
      <AuthLayout title="Link not valid">
        <p>This reset link is missing or incomplete. Request a new one.</p>
        <Link to="/forgot-password" className="mt-4 inline-block text-gold-hover underline underline-offset-4">
          Request a new link
        </Link>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title="Choose a new password" subtitle="At least 10 characters. You will be signed out everywhere.">
      {done ? (
        <p role="status">
          Your password was changed.{' '}
          <Link to="/login" className="text-gold-hover underline underline-offset-4">
            Sign in
          </Link>
        </p>
      ) : (
        <form onSubmit={submit} noValidate className="space-y-4">
          <FormError message={error?.message} details={error?.body.details} />
          <Input label="New password" type="password" autoComplete="new-password" required value={pw} onChange={(e) => setPw(e.target.value)} />
          <Input label="Confirm new password" type="password" autoComplete="new-password" required value={pw2} onChange={(e) => setPw2(e.target.value)} />
          <Button type="submit" className="w-full" loading={busy} disabled={!pw || !pw2}>
            Change password
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

export function VerifyEmailPage() {
  const token = useFragmentToken();
  const [state, setState] = useState<'idle' | 'working' | 'ok' | 'failed'>(token ? 'working' : 'failed');
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true; // StrictMode runs effects twice; the token is single-use
    apiJson('/auth/verify-email', 'POST', { token }).then(
      () => setState('ok'),
      () => setState('failed'),
    );
  }, [token]);

  return (
    <AuthLayout title="E-mail verification">
      {state === 'working' && <p aria-busy="true">Verifying…</p>}
      {state === 'ok' && <p role="status">Your e-mail is verified. You can now sign in from the app.</p>}
      {state === 'failed' && <p role="alert">This link is invalid or has expired. Request a new verification e-mail from the app.</p>}
    </AuthLayout>
  );
}
