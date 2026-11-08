import { AlertCircle, Inbox } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './Button';

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded-input bg-sand ${className}`} />;
}

export function EmptyState({ title, message, action }: { title: string; message?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <Inbox className="size-10 text-muted" aria-hidden />
      <h3 className="mt-4 text-xl">{title}</h3>
      {message && <p className="mt-1 max-w-sm text-sm text-muted">{message}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

export function ErrorState({
  message,
  requestId,
  onRetry,
}: {
  message: string;
  requestId?: string;
  onRetry?: () => void;
}) {
  return (
    <div role="alert" className="flex flex-col items-center px-6 py-12 text-center">
      <AlertCircle className="size-10 text-danger" aria-hidden />
      <h3 className="mt-4 text-xl">Something went wrong</h3>
      <p className="mt-1 max-w-sm text-sm text-muted">{message}</p>
      {requestId && <p className="mt-2 text-xs text-muted">Reference: {requestId}</p>}
      {onRetry && (
        <Button className="mt-6" variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
