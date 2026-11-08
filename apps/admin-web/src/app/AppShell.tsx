import { LayoutDashboard, Menu, Palette, X } from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';

/** Only real, working routes are listed. New sections are added to this list as their phase ships. */
const nav = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/design-system', label: 'Design system', icon: Palette, end: false },
];

export function AppShell() {
  const [open, setOpen] = useState(false);
  const links = (
    <nav aria-label="Main" className="flex flex-col gap-1 p-3">
      {nav.map(({ to, label, icon: Icon, end }) => (
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
        </NavLink>
      ))}
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
