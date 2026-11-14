import { TenantDb } from './tenant-db.service';
import { TenantContext } from './tenant-context';

const SALON_A = '0192b3c4-d5e6-7f80-9a1b-2c3d4e5f6071';
const USER = '0192b3c4-d5e6-7f80-9a1b-2c3d4e5f6072';

function fakePrisma() {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ sql: strings.join('?'), values });
      return [];
    },
  };
  return { calls, prisma: { $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } };
}

describe('TenantDb.withTenant', () => {
  it('sets transaction-local tenant settings before running the callback', async () => {
    const { calls, prisma } = fakePrisma();
    const db = new TenantDb(prisma as never);
    const ctx: TenantContext = { userId: USER, salonId: SALON_A, isPlatformAdmin: false };

    const result = await db.withTenant(ctx, async () => {
      expect(calls).toHaveLength(3); // settings were applied BEFORE business queries
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(calls.every((c) => c.sql.includes("set_config(") && c.sql.includes(', true)'))).toBe(true);
    expect(calls.map((c) => c.values[0])).toEqual([USER, SALON_A, 'false']);
  });

  it('uses empty salon id and admin flag for platform admins', async () => {
    const { calls, prisma } = fakePrisma();
    await new TenantDb(prisma as never).withTenant({ userId: USER, salonId: null, isPlatformAdmin: true }, async () => 1);
    expect(calls.map((c) => c.values[0])).toEqual([USER, '', 'true']);
  });

  it('fails closed on malformed ids (e.g. injection attempts) without touching the database', async () => {
    const { calls, prisma } = fakePrisma();
    const db = new TenantDb(prisma as never);
    await expect(
      db.withTenant({ userId: USER, salonId: "x'; DROP TABLE salons;--", isPlatformAdmin: false }, async () => 1),
    ).rejects.toThrow(/salonId/);
    await expect(db.withTenant({ userId: 'nope', salonId: null, isPlatformAdmin: false }, async () => 1)).rejects.toThrow(
      /userId/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe('TenantDb.withPublicRead', () => {
  it('clears identity, never grants admin, and opts in to public reads for this transaction only', async () => {
    const { calls, prisma } = fakePrisma();
    await new TenantDb(prisma as never).withPublicRead(async () => 1);
    expect(calls).toHaveLength(4);
    expect(calls.every((c) => c.sql.includes('set_config(') && c.sql.includes(', true)'))).toBe(true);
    const sql = calls.map((c) => c.sql).join('\n');
    expect(sql).toContain("'app.is_platform_admin', 'false'");
    expect(sql).toContain("'app.public_read', 'true'");
    expect(sql).toContain("'app.user_id', ''");
    expect(sql).toContain("'app.salon_id', ''");
  });
});


describe('TenantDb.withCustomer', () => {
  it('sets the user, no salon, no admin, and opens the public read context for this transaction only', async () => {
    const { calls, prisma } = fakePrisma();
    await new TenantDb(prisma as never).withCustomer(USER, async () => 1);
    expect(calls).toHaveLength(4);
    expect(calls.every((c) => c.sql.includes('set_config(') && c.sql.includes(', true)'))).toBe(true);
    expect(calls.map((c) => c.values[0])).toEqual([USER]);
    const sql = calls.map((c) => c.sql).join('\n');
    expect(sql).toContain("'app.salon_id', ''");
    expect(sql).toContain("'app.is_platform_admin', 'false'");
    expect(sql).toContain("'app.public_read', 'true'");
  });

  it('fails closed on a malformed user id without touching the database', async () => {
    const { calls, prisma } = fakePrisma();
    await expect(new TenantDb(prisma as never).withCustomer("x'; DROP TABLE users;--", async () => 1)).rejects.toThrow(/userId/);
    expect(calls).toHaveLength(0);
  });
});
