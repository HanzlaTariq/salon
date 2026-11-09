/** SQLSTATE of a database error whether it comes from Prisma raw queries (P2010 + meta.code) or node-postgres. */
export function sqlState(err: unknown): string | undefined {
  const e = err as { code?: unknown; meta?: { code?: unknown } } | null;
  if (!e) return undefined;
  if (e.code === 'P2010' && typeof e.meta?.code === 'string') return e.meta.code;
  return typeof e.code === 'string' ? e.code : undefined;
}

export const isUniqueViolation = (err: unknown): boolean => sqlState(err) === '23505';
