import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Input } from '../../design-system';
import { ApiError } from '../../lib/api';
import { safeInternalPath } from '../../lib/safe-path';
import { useAuth } from './AuthContext';
import { AuthLayout, FormError } from './AuthLayout';

export function LoginPage() {
  const { status, login } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeInternalPath(params.get('next')); // never navigate to an unvalidated URL
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  if (status === 'authenticated') return <Navigate to={next} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password, needsCode ? code.trim() : undefined);
      navigate(next, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'MFA_REQUIRED') {
        setNeedsCode(true);
      } else {
        setError(err instanceof ApiError ? err : new ApiError(0, { code: 'UNKNOWN', message: 'Something went wrong.' }));
        if (needsCode) setCode('');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="Sign in" subtitle="Platform administrators only.">
      <form onSubmit={submit} noValidate className="space-y-4">
        <FormError message={error?.message} />
        <Input label="Email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} disabled={needsCode} />
        <Input label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} disabled={needsCode} />
        {needsCode && (
          <Input
            label="Authentication code"
            hint="6-digit code from your authenticator app, or a recovery code."
            inputMode="text"
            autoComplete="one-time-code"
            autoFocus
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        )}
        <Button type="submit" className="w-full" loading={busy} disabled={!email || !password || (needsCode && !code)}>
          {needsCode ? 'Verify and sign in' : 'Sign in'}
        </Button>
        <p className="text-center text-sm">
          <Link to="/forgot-password" className="text-gold-hover underline underline-offset-4">
            Forgot your password?
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}
