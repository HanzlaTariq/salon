import { useQuery } from '@tanstack/react-query';
import { ApiError, apiFetch } from '../../lib/api';
import { Card, ErrorState, Skeleton, StatCard } from '../../design-system';

/** Phase 1: real connectivity check against the API. Business analytics arrive in Phase 13. */
export function OverviewPage() {
  const live = useQuery({ queryKey: ['health', 'live'], queryFn: () => apiFetch<{ status: string }>('/health') });
  const ready = useQuery({ queryKey: ['health', 'ready'], queryFn: () => apiFetch<{ status: string }>('/health/ready') });

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
    </div>
  );
}
