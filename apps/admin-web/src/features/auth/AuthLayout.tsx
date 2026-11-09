import type { ReactNode } from 'react';

export function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-10">
      <p className="font-serif text-2xl">Salon Admin</p>
      <h1 className="mt-6 text-4xl">{title}</h1>
      {subtitle && <p className="mt-2 text-muted">{subtitle}</p>}
      <div className="mt-8 rounded-card border border-line bg-surface p-6 shadow-soft">{children}</div>
    </main>
  );
}

export function FormError({ message, details }: { message?: string; details?: unknown }) {
  if (!message) return null;
  return (
    <div role="alert" className="mb-4 rounded-input border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
      {message}
      {Array.isArray(details) && (
        <ul className="mt-1 list-disc pl-5">
          {details.map((d) => (
            <li key={String(d)}>{String(d)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
