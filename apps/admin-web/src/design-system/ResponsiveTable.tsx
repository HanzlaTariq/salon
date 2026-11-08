import type { ReactNode } from 'react';
import { EmptyState } from './states';

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** Used as the label in the stacked mobile card layout. */
  primary?: boolean;
}

/** Table on md+ screens; stacked cards on phones. Never overflows the page horizontally. */
export function ResponsiveTable<T>({
  columns,
  rows,
  rowKey,
  emptyTitle = 'Nothing here yet',
  emptyMessage,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  emptyTitle?: string;
  emptyMessage?: string;
}) {
  if (rows.length === 0) return <EmptyState title={emptyTitle} message={emptyMessage} />;
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line text-xs uppercase tracking-wide text-muted">
            <tr>
              {columns.map((c) => (
                <th key={c.key} scope="col" className="px-4 py-3 font-medium">
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={rowKey(r)} className="border-b border-line last:border-0">
                {columns.map((c) => (
                  <td key={c.key} className="px-4 py-3 align-middle">
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-3 md:hidden">
        {rows.map((r) => (
          <li key={rowKey(r)} className="rounded-card border border-line bg-surface p-4">
            {columns.map((c) => (
              <div key={c.key} className={c.primary ? 'mb-2 font-semibold' : 'flex justify-between gap-4 py-1 text-sm'}>
                {!c.primary && <span className="text-muted">{c.header}</span>}
                <span className="min-w-0 break-words text-right">{c.cell(r)}</span>
              </div>
            ))}
          </li>
        ))}
      </ul>
    </>
  );
}
