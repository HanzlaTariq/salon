import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { ErrorState, Skeleton } from '../../design-system';
import { useAuth } from './AuthContext';

/**
 * Gate for the whole signed-in area. Client-side gating is only UX: every API call is authorised again
 * on the server (default-deny guard + role/permission checks).
 */
export function RequireAuth() {
  const { status, mfaEnrollmentRequired, errorMessage, retry } = useAuth();
  const loc = useLocation();

  if (status === 'loading') {
    return (
      <div className="mx-auto max-w-md space-y-4 px-6 py-24" aria-busy="true" aria-label="Loading">
        <Skeleton className="h-10" />
        <Skeleton className="h-32" />
      </div>
    );
  }
  if (status === 'error') return <ErrorState message={errorMessage ?? 'Cannot reach the server.'} onRetry={retry} />;
  if (status === 'anonymous') {
    const next = encodeURIComponent(loc.pathname + loc.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  // Mandatory MFA: nothing but the security page is reachable until enrolment is finished.
  if (mfaEnrollmentRequired && loc.pathname !== '/security') return <Navigate to="/security" replace />;
  return <Outlet />;
}
