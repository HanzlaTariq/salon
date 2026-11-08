import { useState } from 'react';
import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Input,
  ResponsiveTable,
  Skeleton,
  StatusBadge,
  type Status,
} from '../../design-system';

const sample = [
  { id: '1', name: 'Haircut', price: 'Rs. 500', status: 'confirmed' as Status },
  { id: '2', name: 'Facial', price: 'Rs. 1,800', status: 'in_progress' as Status },
  { id: '3', name: 'Beard trim', price: 'Rs. 300', status: 'completed' as Status },
];

/** Living reference for every reusable component (used for visual QA at all breakpoints). */
export function DesignSystemPage() {
  const [confirm, setConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const statuses: Status[] = ['pending', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show'];

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-4xl">Design system</h1>
        <p className="mt-1 text-muted">Components used across the platform.</p>
      </div>

      <section aria-labelledby="buttons" className="space-y-3">
        <h2 id="buttons" className="text-2xl">Buttons</h2>
        <div className="flex flex-wrap gap-3">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive" onClick={() => setConfirm(true)}>Destructive</Button>
          <Button loading>Loading</Button>
          <Button disabled>Disabled</Button>
        </div>
      </section>

      <section aria-labelledby="forms" className="space-y-3">
        <h2 id="forms" className="text-2xl">Form fields</h2>
        <Card className="grid gap-4 sm:grid-cols-2">
          <Input label="Salon name" placeholder="e.g. Royal Cuts" hint="Shown to customers." />
          <Input label="Phone" defaultValue="0300" error="Enter a valid phone number." />
        </Card>
      </section>

      <section aria-labelledby="badges" className="space-y-3">
        <h2 id="badges" className="text-2xl">Status badges</h2>
        <div className="flex flex-wrap gap-2">{statuses.map((s) => <StatusBadge key={s} status={s} />)}</div>
      </section>

      <section aria-labelledby="table" className="space-y-3">
        <h2 id="table" className="text-2xl">Responsive table</h2>
        <Card className="p-2 sm:p-4">
          <ResponsiveTable
            rows={sample}
            rowKey={(r) => r.id}
            columns={[
              { key: 'name', header: 'Service', primary: true, cell: (r) => r.name },
              { key: 'price', header: 'Price', cell: (r) => r.price },
              { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
            ]}
          />
        </Card>
      </section>

      <section aria-labelledby="states" className="space-y-3">
        <h2 id="states" className="text-2xl">Loading, empty and error</h2>
        <div className="grid gap-4 md:grid-cols-3">
          <Card><Skeleton className="h-5 w-2/3" /><Skeleton className="mt-3 h-5 w-full" /><Skeleton className="mt-3 h-5 w-1/2" /></Card>
          <Card><EmptyState title="No salons yet" message="New applications will appear here." /></Card>
          <Card><ErrorState message="We could not load this data." requestId="req-demo-123" onRetry={() => undefined} /></Card>
        </div>
      </section>

      <ConfirmDialog
        open={confirm}
        destructive
        loading={loading}
        title="Suspend this salon?"
        confirmLabel="Suspend"
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setLoading(true);
          setTimeout(() => {
            setLoading(false);
            setConfirm(false);
          }, 600);
        }}
      >
        Suspended salons are hidden from customers. This is a visual demo only.
      </ConfirmDialog>
    </div>
  );
}
