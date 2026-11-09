import { useQuery } from '@tanstack/react-query';
import { ApiError, apiFetch } from '../../lib/api';
import { Link } from 'react-router-dom';
import { Card, ErrorState, Skeleton, StatCard } from '../../design-system';
import { useAuth } from '../auth/AuthContext';

/** Phase 1: real connectivity check against the API. Business analytics arrive in Phase 13. */
export function OverviewPage() {
  const live = useQuery({ queryKey: ['health', 'live'], queryFn: () => apiFetch<{ status: string }>('/health') });
  const ready = useQuery({ queryKey: ['health', 'ready'], queryFn: () => apiFetch<{ status: string }>('/health/ready') });

  const { user } = useAuth();
  const canSeeSalons = !!user && ['SUPER_ADMIN', 'SUPPORT'].includes(user.role);
  const salons = useQuery({
    queryKey: ['salon-stats'],
    enabled: canSeeSalons,
    queryFn: () => apiFetch<{ pending: number; approved: number; suspended: number }>('/admin/salons/stats'),
  });

  const err = (live.error ?? ready.error) as ApiError | null;
  const retry = () => {
    void live.refetch();
    void ready.refetch();
  };

  return (
    <div>
      <h1 className="text-4xl">Overview</h1>
      <p className="mt-1 text-muted">Platform status</p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        {live.isLoading || ready.isLoading ? (
          <>
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
          </>
        ) : err ? (
          <Card className="sm:col-span-2">
            <ErrorState message={err.message} requestId={err.requestId} onRetry={retry} />
          </Card>
        ) : (
          <>
            <StatCard label="API" value={live.data?.status === 'ok' ? 'Online' : 'Unknown'} />
            <StatCard label="Database" value={ready.data?.status === 'ready' ? 'Ready' : 'Unknown'} />
          </>
        )}
      </div>

      {canSeeSalons && salons.data && (
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <Link to="/salons" className="block"><StatCard label="Applications to review" value={salons.data.pending} hint="Open the review queue" /></Link>
          <StatCard label="Approved salons" value={salons.data.approved} />
          <StatCard label="Suspended salons" value={salons.data.suspended} />
        </div>
      )}
    </div>
  );
}
