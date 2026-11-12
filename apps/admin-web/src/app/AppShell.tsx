import { useQuery } from '@tanstack/react-query';
import { CreditCard, Landmark, LayoutDashboard, LogOut, Menu, Palette, Receipt, Scissors, ShieldCheck, Users, X } from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../features/auth/AuthContext';
import { apiFetch } from '../lib/api';

/** Only real, working routes are listed. New sections are added to this list as their phase ships. */
const nav = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true, roles: null as string[] | null },
  { to: '/salons', label: 'Salons', icon: Scissors, end: false, roles: ['SUPER_ADMIN', 'SUPPORT'] },
  { to: '/payments', label: 'Payments', icon: Receipt, end: false, roles: ['SUPER_ADMIN', 'FINANCE'] },
  { to: '/subscriptions', label: 'Subscriptions', icon: CreditCard, end: false, roles: ['SUPER_ADMIN', 'SUPPORT', 'FINANCE'] },
  { to: '/billing-settings', label: 'Billing settings', icon: Landmark, end: false, roles: ['SUPER_ADMIN', 'SUPPORT', 'FINANCE'] },
  { to: '/users', label: 'Users', icon: Users, end: false, roles: ['SUPER_ADMIN', 'SUPPORT'] },
  { to: '/security', label: 'Security', icon: ShieldCheck, end: false, roles: null },
  { to: '/design-system', label: 'Design system', icon: Palette, end: false, roles: null },
];

export function AppShell() {
  const [open, setOpen] = useState(false);
  const { user, mfaEnrollmentRequired, logout } = useAuth();
  const canSeeSalons = !!user && ['SUPER_ADMIN', 'SUPPORT'].includes(user.role) && !mfaEnrollmentRequired;
  // In-app notification: number of applications waiting for review (refreshes every minute).
  const pending = useQuery({
    queryKey: ['salon-stats'],
    enabled: canSeeSalons,
    refetchInterval: 60_000,
    queryFn: () => apiFetch<{ pending: number }>('/admin/salons/stats'),
  });
  // Payments waiting for verification (Super Admin / Finance only; refreshes every minute).
  const canVerify = !!user && ['SUPER_ADMIN', 'FINANCE'].includes(user.role) && !mfaEnrollmentRequired;
  const toVerify = useQuery({
    queryKey: ['billing-overview'],
    enabled: canVerify,
    refetchInterval: 60_000,
    queryFn: () => apiFetch<{ pendingPayments: number }>('/admin/billing/overview'),
  });
  const items = nav.filter((n) => (n.roles === null || (user && n.roles.includes(user.role))) && (!mfaEnrollmentRequired || n.to === '/security'));
  const links = (
    <nav aria-label="Main" className="flex flex-col gap-1 p-3">
      {items.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          onClick={() => setOpen(false)}
          className={({ isActive }) =>
            `flex min-h-11 items-center gap-3 rounded-input px-3 text-sm font-medium transition-colors ${
              isActive ? 'bg-ink text-ivory dark:bg-gold dark:text-ink' : 'hover:bg-sand'
            }`
          }
        >
          <Icon className="size-4" aria-hidden />
          {label}
          {to === '/payments' && (toVerify.data?.pendingPayments ?? 0) > 0 && (
            <span aria-label={`${toVerify.data?.pendingPayments} payments to verify`} className="ml-auto rounded-full bg-gold px-2 py-0.5 text-xs font-semibold text-ink">
              {toVerify.data?.pendingPayments}
            </span>
          )}
          {to === '/salons' && (pending.data?.pending ?? 0) > 0 && (
            <span aria-label={`${pending.data?.pending} pending applications`} className="ml-auto rounded-full bg-gold px-2 py-0.5 text-xs font-semibold text-ink">
              {pending.data?.pending}
            </span>
          )}
        </NavLink>
      ))}
      <div className="mt-4 border-t border-line pt-4">
        <p className="truncate px-3 text-xs text-muted" title={user?.email}>{user?.fullName} · {user?.role.replace('_', ' ').toLowerCase()}</p>
        <button
          type="button"
          onClick={() => void logout()}
          className="mt-1 flex min-h-11 w-full items-center gap-3 rounded-input px-3 text-sm font-medium hover:bg-sand"
        >
          <LogOut className="size-4" aria-hidden />
          Sign out
        </button>
      </div>
    </nav>
  );

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[16rem_1fr]">
      {/* Desktop sidebar */}
      <aside className="hidden border-r border-line bg-surface lg:block">
        <div className="px-6 py-6 font-serif text-2xl">Salon Admin</div>
        {links}
      </aside>

      {/* Mobile / tablet header + drawer */}
      <header className="flex items-center justify-between border-b border-line bg-surface px-4 py-3 lg:hidden">
        <span className="font-serif text-xl">Salon Admin</span>
        <button
          type="button"
          aria-label={open ? 'Close menu' : 'Open menu'}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex size-11 items-center justify-center rounded-input hover:bg-sand"
        >
          {open ? <X className="size-5" /> : <Menu className="size-5" />}
        </button>
      </header>
      {open && <div className="border-b border-line bg-surface lg:hidden">{links}</div>}

      <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-10">
        <Outlet />
      </main>
    </div>
  );
}
