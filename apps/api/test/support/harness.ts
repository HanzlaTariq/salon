// Env must be set BEFORE importing AppModule (it validates env at import time).
process.env.NODE_ENV = 'test';
process.env.AUTH_RATE_LIMIT_FACTOR = process.env.AUTH_RATE_LIMIT_FACTOR ?? '1000'; // tests run many flows from one IP
process.env.LOG_LEVEL = 'silent';
process.env.CORS_ORIGINS = 'https://admin.example.test';
process.env.JWT_ACCESS_SECRET = 'test-secret-'.padEnd(48, 'x');
process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.ARGON2_MEMORY_KIB = '8192'; // fast hashing in tests only
process.env.ARGON2_TIME_COST = '1';
process.env.RATE_LIMIT_MAX = '100000';
process.env.HIBP_CHECK_ENABLED = 'false'; // no outbound calls from tests (unit-tested separately)
delete process.env.REDIS_URL; // tests use the in-memory limiter
process.env.WEB_APP_URL = 'https://admin.example.test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://x:x@localhost:5432/x';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { Clock } from '../../src/common/util/clock';
import { parseEnv } from '../../src/config/env';
import { ConsoleMailer, Mailer } from '../../src/modules/auth/mail/mailer';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PgPrismaAdapter } from './pg-prisma-adapter';

export const ORIGIN = 'https://admin.example.test';
export const GOOD_PASSWORD = 'violet-Harbor-lamp-91';

export class FakeClock extends Clock {
  private t = Date.now();
  override now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export interface Harness {
  app: INestApplication;
  http: () => ReturnType<typeof request>;
  mailer: ConsoleMailer;
  clock: FakeClock;
  /** Direct SQL as the privileged migrator/owner role (test setup & assertions only). */
  admin: Pool;
  close: () => Promise<void>;
}

export const dbEnabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_ADMIN_DATABASE_URL);

export async function createHarness(): Promise<Harness> {
  const clock = new FakeClock();
  let builder = Test.createTestingModule({ imports: [AppModule] }).overrideProvider(Clock).useValue(clock);
  if (process.env.TEST_PRISMA_ADAPTER === 'pg') {
    builder = builder.overrideProvider(PrismaService).useValue(new PgPrismaAdapter(process.env.TEST_DATABASE_URL!));
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  configureApp(app, parseEnv());
  await app.init();
  const admin = new Pool({ connectionString: process.env.TEST_ADMIN_DATABASE_URL, max: 2 });
  return {
    app,
    http: () => request(app.getHttpServer()),
    mailer: app.get(Mailer) as ConsoleMailer,
    clock,
    admin,
    close: async () => {
      await app.close();
      await admin.end();
    },
  };
}

let counter = 0;
export const uniqueEmail = (prefix = 'user') => `${prefix}.${Date.now().toString(36)}.${counter++}@example.test`;

export function lastToken(h: Harness, email: string, subjectIncludes: string): string {
  const msg = [...h.mailer.outbox].reverse().find((m) => m.to === email && m.subject.includes(subjectIncludes));
  if (!msg) throw new Error(`no "${subjectIncludes}" mail for ${email}`);
  const m = /#token=([^\s]+)/.exec(msg.text);
  if (!m) throw new Error('no token in mail');
  return decodeURIComponent(m[1]);
}

export async function registerAndVerify(
  h: Harness,
  opts: { email?: string; accountType?: 'CUSTOMER' | 'SALON_OWNER'; password?: string; fullName?: string } = {},
): Promise<{ email: string; password: string }> {
  const email = opts.email ?? uniqueEmail();
  const password = opts.password ?? GOOD_PASSWORD;
  await h.http().post('/api/v1/auth/register').send({
    email,
    password,
    fullName: opts.fullName ?? 'Test Person',
    accountType: opts.accountType ?? 'CUSTOMER',
  }).expect(202);
  await h.http().post('/api/v1/auth/verify-email').send({ token: lastToken(h, email, 'Verify') }).expect(200);
  return { email, password };
}

export const mobile = { 'X-Client-Type': 'mobile' };

export async function loginMobile(h: Harness, email: string, password: string, mfaCode?: string) {
  return h.http().post('/api/v1/auth/login').set(mobile).send({ email, password, ...(mfaCode ? { mfaCode } : {}) });
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Creates a platform user directly in the database (there is deliberately no API for this). */
export async function createPlatformUser(h: Harness, role: 'SUPER_ADMIN' | 'SUPPORT' | 'FINANCE', password = GOOD_PASSWORD) {
  const email = uniqueEmail(role.toLowerCase());
  const { PasswordService } = await import('../../src/modules/auth/password.service');
  const hash = await h.app.get(PasswordService).hash(password);
  const r = await h.admin.query(
    `INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at)
     VALUES ($1, $2, 'Platform Person', $3::user_role, 'ACTIVE', now()) RETURNING id`,
    [email, hash, role],
  );
  return { id: r.rows[0].id as string, email, password };
}
