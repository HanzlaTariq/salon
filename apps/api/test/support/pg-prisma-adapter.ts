import { Pool, PoolClient } from 'pg';

/**
 * TEST-ONLY stand-in for PrismaService that speaks the same `$queryRaw` / `$executeRaw` /
 * `$transaction` surface over node-postgres. It lets the security suite run against a REAL
 * PostgreSQL where the Prisma query engine cannot be downloaded. Where `prisma generate` works,
 * leave TEST_PRISMA_ADAPTER unset and the suite uses the real PrismaService instead.
 */
type Runner = Pick<Pool | PoolClient, 'query'>;

function build(strings: TemplateStringsArray, values: unknown[]): { text: string; values: unknown[] } {
  let text = strings[0];
  for (let i = 0; i < values.length; i++) text += `$${i + 1}${strings[i + 1]}`;
  return { text, values };
}

class Tx {
  constructor(private readonly runner: Runner) {}
  async $queryRaw<T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> {
    const q = build(strings, values);
    return (await this.runner.query(q.text, q.values)).rows as T;
  }
  async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number> {
    const q = build(strings, values);
    return (await this.runner.query(q.text, q.values)).rowCount ?? 0;
  }
  async $transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return fn(this); // already inside a transaction
  }
}

export class PgPrismaAdapter extends Tx {
  private readonly pool: Pool;
  constructor(url: string) {
    const pool = new Pool({ connectionString: url, max: 10 });
    super(pool);
    this.pool = pool;
  }
  async $connect(): Promise<void> {
    await this.pool.query('SELECT 1');
  }
  async $disconnect(): Promise<void> {
    await this.pool.end();
  }
  override async $transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(new Tx(client));
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}
