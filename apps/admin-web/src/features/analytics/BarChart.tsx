import { barPct, seriesMax } from './format';

export interface BarDatum { label: string; value: number; display: string }

/**
 * Dependency-free bar chart (CSS only). Accessible: the figure has a text summary and every bar carries its value as text for
 * screen readers. Scrolls inside its own box on narrow screens, so the page never scrolls sideways.
 */
export function BarChart({ title, data, tone = 'gold' }: { title: string; data: BarDatum[]; tone?: 'gold' | 'emerald' | 'info' }) {
  const max = seriesMax(data.map((d) => d.value));
  const color = tone === 'emerald' ? 'bg-emerald' : tone === 'info' ? 'bg-info' : 'bg-gold';
  const total = data.reduce((a, d) => a + d.value, 0);
  return (
    <figure aria-label={title} className="min-w-0">
      <figcaption className="sr-only">{`${title}: ${data.map((d) => `${d.label} ${d.display}`).join(', ')}`}</figcaption>
      <div className="overflow-x-auto pb-1">
        <div className="flex h-44 items-end gap-2" style={{ minWidth: `${Math.max(data.length * 40, 0)}px` }} role="img" aria-label={`${title}, ${data.length} periods`}>
          {data.map((d) => (
            <div key={d.label} className="flex h-full min-w-8 flex-1 flex-col items-center justify-end gap-1" title={`${d.label}: ${d.display}`}>
              <span className="text-[10px] leading-none text-muted">{total === 0 ? '' : d.display}</span>
              <div className={`w-full rounded-t-input ${color} ${d.value > 0 ? '' : 'opacity-20'}`} style={{ height: `${d.value > 0 ? barPct(d.value, max) : 2}%` }} />
              <span className="text-[10px] leading-none text-muted">{d.label}</span>
            </div>
          ))}
        </div>
      </div>
    </figure>
  );
}
