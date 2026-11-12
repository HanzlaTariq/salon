import { Pool, PoolClient } from 'pg';
import sharp from 'sharp';
import { ObjectStorage, MemoryObjectStorage } from '../src/common/storage/object-storage';
import { computeRemovalCredit, computeTopUp, prorationWindow, toPaisa, todayKarachi, addDays } from '../src/modules/billing/billing.types';
import { hotp, base32Decode, timeStep } from '../src/modules/auth/totp';
import { Harness, bearer, createHarness, createPlatformUser, dbEnabled, loginMobile, registerAndVerify } from './support/harness';

const d = dbEnabled ? describe : describe.skip;
if (!dbEnabled) {
  // eslint-disable-next-line no-console
  console.warn('SKIPPED billing e2e: set TEST_DATABASE_URL (salon_app) and TEST_ADMIN_DATABASE_URL (salon_migrator).');
}

type Role = 'SUPER_ADMIN' | 'SUPPORT' | 'FINANCE';
const totp = (secretB32: string, h: Harness) => hotp(base32Decode(secretB32), timeStep(h.clock.now().getTime()));
const png = (color = '#c07840') => sharp({ create: { width: 600, height: 400, channels: 3, background: color } }).png().toBuffer();
const SALON = { name: 'Glow Studio', salonType: 'UNISEX', city: 'Lahore', area: 'Gulberg', addressLine: '12 Main Boulevard, Gulberg III', phone: '0300 1234567' };
const WEEK = [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, closed: false, opensAt: '10:00', closesAt: '21:00' })).concat([{ weekday: 7, closed: true } as never]);
const DAY = 86_400_000;
let txnCounter = 0;
const txn = () => `TXN${Date.now().toString(36).toUpperCase()}${txnCounter++}`;

d('Phase 6: subscriptions, invoices, manual payments, top-ups and credits (real PostgreSQL)', () => {
  let h: Harness;
  let appPool: Pool;
  let storage: MemoryObjectStorage;
  let superAdmin: { id: string; email: string; access: string };
  let finance: { id: string; email: string; access: string };
  let support: { id: string; email: string; access: string };
  let RECEIPT: Buffer;

  beforeAll(async () => {
    h = await createHarness();
    appPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
    storage = h.app.get(ObjectStorage) as MemoryObjectStorage;
    RECEIPT = await png('#336699');
    superAdmin = await platformUser('SUPER_ADMIN');
    finance = await platformUser('FINANCE');
    support = await platformUser('SUPPORT');
    // Price list + payment instructions are configured by the Super Admin (nothing is hardcoded).
    await h.http().post('/api/v1/admin/billing/plans').set(bearer(superAdmin.access))
      .send({ monthlyPricePerStaff: '300', yearlyPricePerStaff: '3000', graceDays: 3, renewalNoticeDays: 7 }).expect(201);
    await h.http().post('/api/v1/admin/billing/payment-methods').set(bearer(superAdmin.access))
      .send({ method: 'JAZZCASH', accountTitle: 'Salon Platform', accountNumber: '03001234567' }).expect(201);
  });
  afterAll(async () => {
    await appPool.end();
    await h.close();
  });

  // ------------------------------------------------------------------ helpers
  async function aq(sql: string, params: unknown[] = [], ctx: { admin?: boolean; user?: string } = { admin: true }) {
    const c = await h.admin.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.is_platform_admin',$1,true), set_config('app.user_id',$2,true)`, [ctx.admin ? 'true' : 'false', ctx.user ?? '']);
      const r = await c.query(sql, params);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async function asApp<T>(ctx: { user?: string; salon?: string; admin?: boolean }, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `SELECT set_config('app.user_id',$1,true), set_config('app.salon_id',$2,true), set_config('app.is_platform_admin',$3,true), set_config('app.public_read','false',true)`,
        [ctx.user ?? '', ctx.salon ?? '', ctx.admin ? 'true' : 'false'],
      );
      return await fn(c);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }
  async function platformUser(role: Role) {
    const u = await createPlatformUser(h, role);
    const access = (await loginMobile(h, u.email, u.password)).body.data.accessToken as string;
    const setup = (await h.http().post('/api/v1/auth/mfa/setup').set(bearer(access)).send({ password: u.password }).expect(200)).body.data;
    await h.http().post('/api/v1/auth/mfa/enable').set(bearer(access)).send({ code: totp(setup.secret, h) }).expect(200);
    return { id: u.id, email: u.email, access };
  }
  async function owner() {
    const u = await registerAndVerify(h, { accountType: 'SALON_OWNER', fullName: 'Owner Person' });
    const access = (await loginMobile(h, u.email, u.password)).body.data.accessToken as string;
    const id = (await aq('SELECT id FROM users WHERE email=$1', [u.email])).rows[0].id as string;
    return { ...u, access, id };
  }
  const upload = (token: string, kind: string, docType: string, buf: Buffer) =>
    h.http().post('/api/v1/salons/mine/files').set(bearer(token)).field('kind', kind).field('docType', docType).attach('file', buf, 'x.png');
  const team = (t: string) => ({
    post: (b: object) => h.http().post('/api/v1/salons/mine/team').set(bearer(t)).send(b),
    patch: (id: string, b: object) => h.http().patch(`/api/v1/salons/mine/team/${id}`).set(bearer(t)).send(b),
    del: (id: string) => h.http().delete(`/api/v1/salons/mine/team/${id}`).set(bearer(t)),
  });
  const bill = (t: string) => ({
    get: (p = '') => h.http().get(`/api/v1/salons/mine/billing${p}`).set(bearer(t)),
    post: (p: string, b: object = {}) => h.http().post(`/api/v1/salons/mine/billing${p}`).set(bearer(t)).send(b),
  });
  const admin = (t: string) => ({
    get: (p: string) => h.http().get(`/api/v1/admin${p}`).set(bearer(t)),
    post: (p: string, b: object = {}) => h.http().post(`/api/v1/admin${p}`).set(bearer(t)).send(b),
  });
  const today = () => todayKarachi(h.clock.now());

  /** Owner with an APPROVED salon and `n` billable staff (the owner performs services + n-1 more). */
  async function approvedSalon(n = 2) {
    const o = await owner();
    const salonId = (await h.http().post('/api/v1/salons').set(bearer(o.access)).send(SALON).expect(201)).body.data.salon.id as string;
    await h.http().put('/api/v1/salons/mine/opening-hours').set(bearer(o.access)).send({ days: WEEK }).expect(200);
    await upload(o.access, 'DOCUMENT', 'CNIC_FRONT', await png()).expect(201);
    await upload(o.access, 'DOCUMENT', 'CNIC_BACK', await png()).expect(201);
    await upload(o.access, 'PHOTO', 'COVER', await png()).expect(201);
    await h.http().post('/api/v1/salons/mine/submit').set(bearer(o.access)).expect(200);
    await h.http().post(`/api/v1/admin/salons/${salonId}/approve`).set(bearer(superAdmin.access)).expect(200);
    const t = team(o.access);
    await t.post({ self: true, performsServices: true }).expect(201);
    const staff: string[] = [];
    for (let i = 1; i < n; i += 1) staff.push((await t.post({ displayName: `Stylist ${i}` }).expect(201)).body.data.id as string);
    return { o, salonId, t, b: bill(o.access), staff };
  }
  function submit(token: string, invoiceId: string, amount: string, o: { tid?: string; method?: string; paidOn?: string; file?: Buffer | null } = {}) {
    const req = h.http().post(`/api/v1/salons/mine/billing/invoices/${invoiceId}/payments`).set(bearer(token))
      .field('method', o.method ?? 'JAZZCASH').field('transactionId', o.tid ?? txn()).field('claimedAmount', amount).field('paidOn', o.paidOn ?? today());
    return o.file === null ? req : req.attach('receipt', o.file ?? RECEIPT, 'receipt.png');
  }
  /** Owner subscribes (monthly), pays and the Finance user approves: returns the subscription summary. */
  async function activate(x: Awaited<ReturnType<typeof approvedSalon>>, cycle: 'MONTHLY' | 'YEARLY' = 'MONTHLY') {
    const inv = (await x.b.post('/invoices', { cycle }).expect(201)).body.data;
    const pay = (await submit(x.o.access, inv.id, inv.total).expect(201)).body.data;
    await admin(finance.access).post(`/payments/${pay.id}/approve`, { receivedAmount: inv.total }).expect(200);
    return { inv, pay, summary: (await x.b.get().expect(200)).body.data };
  }

  // ------------------------------------------------------------------ access control
  it('default deny: only owners reach owner billing; admin billing needs the right permission', async () => {
    const x = await approvedSalon(1);
    const cust = await registerAndVerify(h, { accountType: 'CUSTOMER' });
    const custTok = (await loginMobile(h, cust.email, cust.password)).body.data.accessToken as string;
    await h.http().get('/api/v1/salons/mine/billing').expect(401);
    await bill(custTok).get().expect(403);
    await admin(x.o.access).get('/payments').expect(403);
    await admin(x.o.access).get('/billing/overview').expect(403);

    await admin(support.access).get('/billing/plans').expect(200); // read-only
    await admin(support.access).get('/payments').expect(403); // no receipts / payments for support
    await admin(support.access).post('/billing/plans', { monthlyPricePerStaff: '1', yearlyPricePerStaff: '1', graceDays: 0, renewalNoticeDays: 1 }).expect(403);
    await admin(finance.access).get('/payments').expect(200);
    await admin(finance.access).post('/billing/plans', { monthlyPricePerStaff: '1', yearlyPricePerStaff: '1', graceDays: 0, renewalNoticeDays: 1 }).expect(403);
    await admin(finance.access).post(`/salons/${x.salonId}/subscription/grant`, { cycle: 'MONTHLY', reason: 'not allowed' }).expect(403);
    await admin(finance.access).post('/billing/payment-methods', { method: 'EASYPAISA', accountTitle: 'X Y', accountNumber: '0300000000' }).expect(403);
  });

  it('plans: money is a validated decimal string, history is immutable, price changes never touch an issued invoice', async () => {
    const s = admin(superAdmin.access);
    await s.post('/billing/plans', { monthlyPricePerStaff: 300.5, yearlyPricePerStaff: '3000', graceDays: 3, renewalNoticeDays: 7 }).expect(400); // float rejected
    await s.post('/billing/plans', { monthlyPricePerStaff: '300.555', yearlyPricePerStaff: '3000', graceDays: 3, renewalNoticeDays: 7 }).expect(400);
    await s.post('/billing/plans', { monthlyPricePerStaff: '0', yearlyPricePerStaff: '3000', graceDays: 3, renewalNoticeDays: 7 }).expect(400);
    await s.post('/billing/plans', { monthlyPricePerStaff: '300', yearlyPricePerStaff: '3000', graceDays: 99, renewalNoticeDays: 7 }).expect(400);
    await s.post('/billing/plans', { monthlyPricePerStaff: '300', yearlyPricePerStaff: '3000', graceDays: 3, renewalNoticeDays: 7, effectiveFrom: '2020-01-01T00:00:00Z' }).expect(400);
    const plans = (await s.get('/billing/plans').expect(200)).body.data;
    expect(plans.current.monthlyPricePerStaff).toBe('300.00');
    // No UPDATE/DELETE policy exists (and the append-only trigger backs it up): nothing can be rewritten, even by the table owner.
    expect((await aq(`UPDATE subscription_plans SET monthly_price_per_staff = 1`)).rowCount).toBe(0);
    expect((await aq(`DELETE FROM subscription_plans`)).rowCount).toBe(0);
    expect((await aq(`SELECT 1 FROM subscription_plans WHERE monthly_price_per_staff = 1`)).rowCount).toBe(0);
  });

  // ------------------------------------------------------------------ invoice + payment
  it('quotes follow the plan: Rs. 300 x 2 staff = Rs. 600 monthly; the owner cannot invoice without billable staff', async () => {
    const lone = await approvedSalon(1);
    // The owner alone performs services => ONE billable staff (never counted twice).
    let sum = (await lone.b.get().expect(200)).body.data;
    expect(sum.billableStaff).toBe(1);
    expect(sum.quotes.MONTHLY.total).toBe('300.00');
    await lone.t.patch((await h.http().get('/api/v1/salons/mine/team').set(bearer(lone.o.access))).body.data.members[0].id, { performsServices: false }).expect(200);
    sum = (await lone.b.get().expect(200)).body.data;
    expect(sum.billableStaff).toBe(0);
    expect(sum.canCreateInvoice.allowed).toBe(false);
    await lone.b.post('/invoices', { cycle: 'MONTHLY' }).expect(409);

    const x = await approvedSalon(2);
    sum = (await x.b.get().expect(200)).body.data;
    expect(sum.billableStaff).toBe(2);
    expect(sum.quotes.MONTHLY.total).toBe('600.00');
    expect(sum.quotes.YEARLY.total).toBe('6000.00');
    expect(sum.subscription.phase).toBe('NONE');
    expect(sum.paymentMethods.length).toBeGreaterThan(0);
  });

  it('owner invoice -> payment with receipt -> PENDING (never paid before verification); invalid submissions are refused', async () => {
    const x = await approvedSalon(2);
    const inv = (await x.b.post('/invoices', { cycle: 'MONTHLY' }).expect(201)).body.data;
    expect(inv).toMatchObject({ kind: 'INITIAL', status: 'OPEN', staffCount: 2, total: '600.00', unitPrice: '300.00' });
    await x.b.post('/invoices', { cycle: 'MONTHLY' }).expect(409); // one open invoice at a time

    await submit(x.o.access, inv.id, '600.00', { file: null }).expect(400); // receipt required
    await submit(x.o.access, inv.id, '500.00').expect(400); // amount must equal the invoice total
    await submit(x.o.access, inv.id, '600.00', { paidOn: addDays(today(), 1) }).expect(400); // future date
    await submit(x.o.access, inv.id, '600.00', { paidOn: addDays(today(), -90) }).expect(400); // recycled old receipt
    await submit(x.o.access, inv.id, '600.00', { tid: 'x' }).expect(400); // transaction id format
    await submit(x.o.access, inv.id, '600.00', { method: 'BANK_TRANSFER' }).expect(400); // method not configured by the admin
    await submit(x.o.access, inv.id, '600.00', { file: Buffer.from('<?php echo 1; ?> not an image') }).expect(415); // magic bytes decide, not the file name
    const stored = storage.objects.size;

    const pay = (await submit(x.o.access, inv.id, '600.00').expect(201)).body.data;
    expect(pay.status).toBe('PENDING');
    expect(pay).not.toHaveProperty('receiptKey');
    expect(storage.objects.size).toBe(stored + 1);
    const key = [...storage.objects.keys()].find((k) => k.startsWith(`billing/${x.salonId}/`))!;
    expect(storage.objects.get(key)!.contentType).toBe('image/webp'); // re-encoded, EXIF stripped

    const sum = (await x.b.get().expect(200)).body.data;
    expect(sum.subscription.phase).toBe('NONE'); // NOT active before a reviewer approves
    expect(sum.openInvoice.paymentStatus).toBe('PENDING');
    await submit(x.o.access, inv.id, '600.00').expect(409); // one live payment per invoice
    await x.b.post(`/invoices/${inv.id}/cancel`).expect(409); // cannot cancel while it is under review
  });

  it('a transaction id is usable once: reusing it for another salon is refused without revealing who used it', async () => {
    const a = await approvedSalon(1);
    const b = await approvedSalon(1);
    const ia = (await a.b.post('/invoices', { cycle: 'MONTHLY' }).expect(201)).body.data;
    const ib = (await b.b.post('/invoices', { cycle: 'MONTHLY' }).expect(201)).body.data;
    const tid = txn();
    await submit(a.o.access, ia.id, ia.total, { tid }).expect(201);
    const before = storage.objects.size;
    const r = await submit(b.o.access, ib.id, ib.total, { tid: tid.toLowerCase() }).expect(409);
    expect(JSON.stringify(r.body)).not.toContain(a.salonId);
    expect(storage.objects.size).toBe(before); // the orphan receipt was removed
  });

  it('a cancelled invoice can be recreated, and an invoice priced for an old team size is flagged stale', async () => {
    const x = await approvedSalon(2);
    const inv = (await x.b.post('/invoices', { cycle: 'MONTHLY' }).expect(201)).body.data;
    await x.t.post({ displayName: 'Late joiner' }).expect(201); // team grows after the invoice was issued
    const open = (await x.b.get().expect(200)).body.data.openInvoice;
    expect(open.stale).toBe(true);
    await x.b.post(`/invoices/${inv.id}/cancel`).expect(200);
    const again = (await x.b.post('/invoices', { cycle: 'YEARLY' }).expect(201)).body.data;
    expect(again).toMatchObject({ staffCount: 3, total: '9000.00' });
  });

  // ------------------------------------------------------------------ database defence in depth
  it('RLS and triggers: an owner cannot pay, approve or read another salon\'s billing even with direct SQL', async () => {
    const a = await approvedSalon(1);
    const b = await approvedSalon(1);
    const ia = (await a.b.post('/invoices', { cycle: 'MONTHLY' }).expect(201)).body.data;
    const pa = (await submit(a.o.access, ia.id, ia.total).expect(201)).body.data;

    const mine = { user: a.o.id, salon: a.salonId };
    await asApp(mine, async (c) => expect((await c.query('SELECT 1 FROM invoices')).rowCount).toBe(1));
    // the other owner (and no context at all) sees nothing
    await asApp({ user: b.o.id, salon: b.salonId }, async (c) => {
      for (const t of ['invoices', 'payments', 'salon_credits', 'salon_subscriptions', 'subscription_staff_snapshots']) {
        expect((await c.query(`SELECT 1 FROM ${t} WHERE salon_id = $1`, [a.salonId])).rowCount).toBe(0);
      }
    });
    await asApp({ user: b.o.id, salon: a.salonId }, async (c) => expect((await c.query('SELECT 1 FROM payments')).rowCount).toBe(0)); // forged salon id
    await asApp({}, async (c) => expect((await c.query('SELECT 1 FROM payments')).rowCount).toBe(0)); // fail closed

    // the owner cannot approve their own payment, mark an invoice paid, or mint a subscription
    await asApp(mine, async (c) => {
      await c.query('SAVEPOINT s1');
      // RLS offers the owner no UPDATE policy on a PENDING payment: the statement matches zero rows
      expect((await c.query(`UPDATE payments SET status='APPROVED', received_amount=1, reviewed_by=$1, reviewed_at=now() WHERE id=$2`, [a.o.id, pa.id])).rowCount).toBe(0);
      expect((await c.query(`SELECT status FROM payments WHERE id=$1`, [pa.id])).rows[0].status).toBe('PENDING');
      await expect(c.query(`UPDATE invoices SET status='PAID', paid_at=now(), period_start=current_date, period_end=current_date+30 WHERE id=$1`, [ia.id])).rejects.toThrow();
      await c.query('ROLLBACK TO s1');
      await expect(c.query(
        `INSERT INTO salon_subscriptions (salon_id, billing_cycle, period_start, period_end, covered_staff_count, period_unit_price)
         VALUES ($1,'MONTHLY',current_date,current_date+30,5,0)`, [a.salonId])).rejects.toThrow(/paid invoice/);
      await c.query('ROLLBACK TO s1');
      await expect(c.query(`UPDATE invoices SET total = 0.01, subtotal = 0.01 WHERE id=$1`, [ia.id])).rejects.toThrow();
      await c.query('ROLLBACK TO s1');
      await expect(c.query(`INSERT INTO salon_credits (salon_id, amount, reason, invoice_id, created_by) VALUES ($1,-5,'APPLIED_TO_INVOICE',$2,$3)`, [a.salonId, ia.id, a.o.id])).rejects.toThrow(/below zero/);
    });
    // even the table owner cannot delete financial records, nor approve outside a Finance/Super Admin identity
    expect((await aq(`DELETE FROM invoices WHERE id=$1`, [ia.id])).rowCount).toBe(0);
    const approveSql = `UPDATE payments SET status='APPROVED', received_amount=$2, reviewed_by=$3, reviewed_at=now() WHERE id=$1`;
    expect((await aq(approveSql, [pa.id, ia.total, a.o.id])).rowCount).toBe(0); // platform flag without a platform identity
    expect((await aq(approveSql, [pa.id, ia.total, support.id], { admin: true, user: support.id })).rowCount).toBe(0); // Support may read, never decide
    expect((await aq(approveSql, [pa.id, ia.total, a.o.id], { admin: false, user: a.o.id })).rowCount).toBe(0);
    expect((await aq(`SELECT status FROM payments WHERE id=$1`, [pa.id])).rows[0].status).toBe('PENDING');
    // a real reviewer identity passes the policy but the trigger still demands the exact invoice amount and own reviewer id
    await expect(aq(`UPDATE payments SET status='APPROVED', received_amount=1, reviewed_by=$2, reviewed_at=now() WHERE id=$1`, [pa.id, finance.id], { admin: true, user: finance.id })).rejects.toThrow(/received amount/);
    await expect(aq(approveSql, [pa.id, ia.total, a.o.id], { admin: true, user: finance.id })).rejects.toThrow(/reviewer must be/);
    // receipts are private: another owner gets 404, never a URL
    await h.http().get(`/api/v1/salons/mine/billing/payments/${pa.id}/receipt-url`).set(bearer(b.o.access)).expect(404);
    await a.b.get(`/payments/${pa.id}/receipt-url`).expect(200);
  });

  // ------------------------------------------------------------------ verification workflow
  it('Finance verifies: query -> owner answers -> approve activates the subscription once; the amount must be confirmed', async () => {
    const x = await approvedSalon(2);
    const inv = (await x.b.post('/invoices', { cycle: 'MONTHLY' }).expect(201)).body.data;
    const pay = (await submit(x.o.access, inv.id, inv.total).expect(201)).body.data;
    const f = admin(finance.access);

    const queue = (await f.get('/payments?status=PENDING').expect(200)).body.data;
    expect(queue.items.some((p: { id: string }) => p.id === pay.id)).toBe(true);
    const detail = (await f.get(`/payments/${pay.id}`).expect(200)).body.data;
    expect(detail.payment.salon.name).toBe('Glow Studio');
    expect(detail.payment.amountMatchesInvoice).toBe(true);
    const url = (await f.get(`/payments/${pay.id}/receipt-url`).expect(200)).body.data.url as string;
    expect(url).toContain('memory://private/billing/');
    expect((await aq(`SELECT 1 FROM audit_logs WHERE action='payment.receipt_viewed' AND target_id=$1`, [pay.id])).rowCount).toBe(1);

    await f.post(`/payments/${pay.id}/approve`, { receivedAmount: '599.99' }).expect(400); // must confirm the real amount
    await f.post(`/payments/${pay.id}/request-info`, { reason: 'x' }).expect(400);
    await f.post(`/payments/${pay.id}/request-info`, { reason: 'The sender name on the receipt does not match.' }).expect(200);
    const asked = (await x.b.get('/payments').expect(200)).body.data.items[0];
    expect(asked).toMatchObject({ status: 'NEEDS_INFO', message: 'The sender name on the receipt does not match.' });
    expect((await x.b.get().expect(200)).body.data.subscription.phase).toBe('NONE');
    await f.post(`/payments/${pay.id}/approve`, { receivedAmount: inv.total }).expect(409); // cannot approve while info is outstanding

    await h.http().post(`/api/v1/salons/mine/billing/payments/${pay.id}/respond`).set(bearer(x.o.access)).field('note', 'Sent from my brother\'s account').expect(200);
    await f.post(`/payments/${pay.id}/approve`, { receivedAmount: inv.total }).expect(200);

    const sum = (await x.b.get().expect(200)).body.data;
    expect(sum.subscription).toMatchObject({ phase: 'ACTIVE', billingCycle: 'MONTHLY', coveredStaff: 2, periodStart: today(), isOperational: true });
    expect(sum.subscription.daysLeft).toBeGreaterThanOrEqual(28);
    expect(sum.openInvoice).toBeNull();
    expect((await x.b.get('/invoices').expect(200)).body.data.items[0].status).toBe('PAID');
    expect(h.mailer.outbox.some((m) => m.to === x.o.email && m.subject.includes('Payment verified'))).toBe(true);
    const reviewer = (await aq(`SELECT reviewed_by, received_amount::text AS amt FROM payments WHERE id=$1`, [pay.id])).rows[0];
    expect(reviewer).toMatchObject({ reviewed_by: finance.id, amt: '600.00' });
    for (const action of ['payment.submitted', 'payment.info_requested', 'payment.info_provided', 'payment.approved', 'invoice.paid', 'subscription.activated']) {
      expect((await aq(`SELECT 1 FROM audit_logs WHERE action=$1 AND salon_id=$2`, [action, x.salonId])).rowCount).toBeGreaterThan(0);
    }
    await f.post(`/payments/${pay.id}/approve`, { receivedAmount: inv.total }).expect(409); // already decided
    await f.post(`/payments/${pay.id}/reject`, { reason: 'Changed my mind later' }).expect(409);
  });

  it('two reviewers approving the same payment at once: exactly one wins, the subscription is activated once', async () => {
    const x = await approvedSalon(1);
    const inv = (await x.b.post('/invoices', { cycle: 'YEARLY' }).expect(201)).body.data;
    const pay = (await submit(x.o.access, inv.id, inv.total).expect(201)).body.data;
    const rs = await Promise.all([
      admin(finance.access).post(`/payments/${pay.id}/approve`, { receivedAmount: inv.total }),
      admin(superAdmin.access).post(`/payments/${pay.id}/approve`, { receivedAmount: inv.total }),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await aq(`SELECT count(*)::int AS n FROM salon_subscriptions WHERE salon_id=$1`, [x.salonId])).rows[0].n).toBe(1);
    expect((await aq(`SELECT count(*)::int AS n FROM audit_logs WHERE action='subscription.activated' AND salon_id=$1`, [x.salonId])).rows[0].n).toBe(1);
  });

  it('a rejected payment keeps the invoice open and the owner can submit a new one', async () => {
    const x = await approvedSalon(1);
    const inv = (await x.b.post('/invoices', { cycle: 'MONTHLY' }).expect(201)).body.data;
    const tid = txn();
    const pay = (await submit(x.o.access, inv.id, inv.total, { tid }).expect(201)).body.data;
    await admin(finance.access).post(`/payments/${pay.id}/reject`, { reason: 'Nothing arrived in our account.' }).expect(200);
    const sum = (await x.b.get().expect(200)).body.data;
    expect(sum.subscription.phase).toBe('NONE');
    expect(sum.openInvoice.paymentStatus).toBeNull();
    expect((await x.b.get('/payments').expect(200)).body.data.items[0]).toMatchObject({ status: 'REJECTED', message: 'Nothing arrived in our account.' });
    await submit(x.o.access, inv.id, inv.total, { tid }).expect(201); // the same id may be corrected and resent after a rejection
  });

  // ------------------------------------------------------------------ mid-period staff changes (agreed rule: top-up on add, credit on removal)
  it('adding staff mid-period creates ONE prorated top-up; paying it raises coverage; removal gives a credit used on renewal', async () => {
    const x = await approvedSalon(2);
    const { summary } = await activate(x);
    const sub = summary.subscription;
    expect(sub.coveredStaff).toBe(2);
    const periodEnd = sub.periodEnd as string;

    // 15 days into the period a third stylist joins
    h.clock.advance(15 * DAY);
    const extra = (await x.t.post({ displayName: 'Third stylist' }).expect(201)).body.data.id as string;
    let s = (await x.b.get().expect(200)).body.data;
    const win = prorationWindow({ periodStart: sub.periodStart, periodEnd }, today());
    const expectedTop = computeTopUp({ unitPaisa: 30000, staff: 1, discountPercent: 0, remainingDays: win.remainingDays, totalDays: win.totalDays, creditBalancePaisa: 0 });
    expect(s.openTopUp).toMatchObject({ kind: 'TOP_UP', staffCount: 1, status: 'OPEN', proration: { remainingDays: win.remainingDays, totalDays: win.totalDays } });
    expect(toPaisa(s.openTopUp.total)).toBe(expectedTop.total);
    expect(toPaisa(s.openTopUp.total)).toBeLessThan(30000); // part of a period, never more than a full price
    expect(s.subscription.coveredStaff).toBe(2); // the already-paid subscription is NOT silently changed

    // another stylist before paying: the unpaid top-up is replaced, never duplicated
    const extra2 = (await x.t.post({ displayName: 'Fourth stylist' }).expect(201)).body.data.id as string;
    s = (await x.b.get().expect(200)).body.data;
    expect(s.openTopUp.staffCount).toBe(2);
    expect((await aq(`SELECT count(*)::int AS n FROM invoices WHERE salon_id=$1 AND kind='TOP_UP' AND status='OPEN'`, [x.salonId])).rows[0].n).toBe(1);
    // ...and removing him again voids it down to one, without any credit (nothing was paid for him)
    await x.t.del(extra2).expect(204);
    s = (await x.b.get().expect(200)).body.data;
    expect(s.openTopUp.staffCount).toBe(1);
    expect(s.creditBalance).toBe('0.00');

    // pay and approve the top-up
    const top = s.openTopUp;
    const pay = (await submit(x.o.access, top.id, top.total).expect(201)).body.data;
    await x.t.del(extra).expect(204); // removed while the payment is being reviewed: billing waits for the decision
    expect((await x.b.get().expect(200)).body.data.subscription.coveredStaff).toBe(2);
    await admin(finance.access).post(`/payments/${pay.id}/approve`, { receivedAmount: top.total }).expect(200);
    // The approval reconciles: coverage rose to 3, then the removed stylist is credited for the unused days.
    s = (await x.b.get().expect(200)).body.data;
    expect(s.subscription.coveredStaff).toBe(2);
    expect(s.openTopUp).toBeNull();
    const credit = computeRemovalCredit({ unitPaisa: 30000, discountPercent: 0, removed: 1, remainingDays: win.remainingDays, totalDays: win.totalDays });
    expect(toPaisa(s.creditBalance)).toBe(credit);
    expect(credit).toBeGreaterThan(0);

    // renewal: not before the window, then the credit is spent first, and the new period continues without a gap
    await x.b.post('/invoices', { cycle: 'MONTHLY' }).expect(409);
    h.clock.advance(10 * DAY); // inside the 7-day renewal window of a ~30 day period
    expect(today() < periodEnd).toBe(true);
    const renewal = (await x.b.post('/invoices', { cycle: 'MONTHLY' }).expect(201)).body.data;
    expect(renewal).toMatchObject({ kind: 'RENEWAL', staffCount: 2, subtotal: '600.00' });
    expect(toPaisa(renewal.creditApplied)).toBe(credit);
    expect(toPaisa(renewal.total)).toBe(60000 - credit);
    const rp = (await submit(x.o.access, renewal.id, renewal.total).expect(201)).body.data;
    await admin(superAdmin.access).post(`/payments/${rp.id}/approve`, { receivedAmount: renewal.total }).expect(200);
    s = (await x.b.get().expect(200)).body.data;
    expect(s.subscription.periodStart).toBe(periodEnd);
    expect(s.creditBalance).toBe('0.00');
    expect(s.subscription.coveredStaff).toBe(2);
    // history of the billable staff count was recorded
    const snaps = (await admin(superAdmin.access).get(`/salons/${x.salonId}/subscription`).expect(200)).body.data.staffHistory;
    expect(snaps.length).toBeGreaterThanOrEqual(3);
  });

  it('phases: active -> grace -> expired follow the dates and the grace period; the admin lists overdue salons', async () => {
    const x = await approvedSalon(1);
    const { summary } = await activate(x);
    const end = summary.subscription.periodEnd as string;
    const daysTo = (iso: string) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) / DAY);
    h.clock.advance(daysTo(end) * DAY);
    let s = (await x.b.get().expect(200)).body.data.subscription;
    expect(s).toMatchObject({ phase: 'GRACE', isOperational: true });
    h.clock.advance(3 * DAY); // plan grace = 3 days
    s = (await x.b.get().expect(200)).body.data.subscription;
    expect(s).toMatchObject({ phase: 'EXPIRED', isOperational: false });
    const list = (await admin(finance.access).get('/subscriptions?phase=EXPIRED&pageSize=100').expect(200)).body.data;
    expect(list.items.some((r: { salonId: string }) => r.salonId === x.salonId)).toBe(true);
    // renewing after expiry starts today (no back-dating)
    const inv = (await x.b.post('/invoices', { cycle: 'MONTHLY' }).expect(201)).body.data;
    const p = (await submit(x.o.access, inv.id, inv.total).expect(201)).body.data;
    await admin(finance.access).post(`/payments/${p.id}/approve`, { receivedAmount: inv.total }).expect(200);
    s = (await x.b.get().expect(200)).body.data.subscription;
    expect(s).toMatchObject({ phase: 'ACTIVE', periodStart: today() });
  });

  // ------------------------------------------------------------------ admin subscription controls and promotions
  it('Super Admin: suspend / reactivate / complimentary grant are audited; a suspended subscription cannot be renewed', async () => {
    const x = await approvedSalon(1);
    await activate(x);
    const s = admin(superAdmin.access);
    await s.post(`/salons/${x.salonId}/subscription/suspend`, { reason: 'abc' }).expect(400);
    const suspended = (await s.post(`/salons/${x.salonId}/subscription/suspend`, { reason: 'Chargeback dispute under review' }).expect(200)).body.data;
    expect(suspended.subscription.phase).toBe('SUSPENDED');
    expect((await x.b.get().expect(200)).body.data.subscription.isOperational).toBe(false);
    await x.b.post('/invoices', { cycle: 'MONTHLY' }).expect(409);
    const back = (await s.post(`/salons/${x.salonId}/subscription/reactivate`, { reason: 'Dispute resolved' }).expect(200)).body.data;
    expect(back.subscription.phase).toBe('ACTIVE');
    for (const action of ['subscription.suspended', 'subscription.reactivated']) {
      expect((await aq(`SELECT 1 FROM audit_logs WHERE action=$1 AND salon_id=$2`, [action, x.salonId])).rowCount).toBe(1);
    }

    // complimentary period on a salon that never paid: free for the whole period, even for staff added later
    const y = await approvedSalon(1);
    const granted = (await s.post(`/salons/${y.salonId}/subscription/grant`, { cycle: 'MONTHLY', reason: 'Launch partner, first month free' }).expect(200)).body.data;
    expect(granted.subscription).toMatchObject({ phase: 'ACTIVE', unitPrice: '0.00' });
    expect(granted.invoices[0]).toMatchObject({ kind: 'COMPLIMENTARY', status: 'PAID', total: '0.00' });
    await y.t.post({ displayName: 'Added during the free month' }).expect(201);
    const after = (await y.b.get().expect(200)).body.data;
    expect(after.subscription.coveredStaff).toBe(2);
    expect(after.openTopUp).toBeNull();

    // a Finance user cannot void invoices either (Super Admin only), and a paid invoice cannot be voided at all
    const z = await approvedSalon(1);
    const inv = (await z.b.post('/invoices', { cycle: 'MONTHLY' }).expect(201)).body.data;
    await admin(finance.access).post(`/invoices/${inv.id}/void`, { reason: 'duplicate invoice' }).expect(403);
    await s.post(`/invoices/${inv.id}/void`, { reason: 'Issued by mistake' }).expect(200);
    expect((await z.b.get().expect(200)).body.data.openInvoice).toBeNull();
  });

  it('promotions: the best active discount is applied and snapshotted; deactivated promotions stop applying', async () => {
    const s = admin(superAdmin.access);
    await s.post('/billing/promotions', { name: 'Bad', percentOff: '101', appliesTo: 'ANY', startsOn: today() }).expect(400);
    await s.post('/billing/promotions', { name: 'Bad dates', percentOff: '10', appliesTo: 'ANY', startsOn: today(), endsOn: addDays(today(), -1) }).expect(400);
    const promo = (await s.post('/billing/promotions', { name: 'Launch 20', percentOff: '20', appliesTo: 'YEARLY', startsOn: today(), endsOn: addDays(today(), 30) }).expect(201)).body.data;
    const x = await approvedSalon(2);
    const quote = (await x.b.get().expect(200)).body.data.quotes;
    expect(quote.MONTHLY.discountPercent).toBe(0);
    expect(quote.YEARLY).toMatchObject({ subtotal: '6000.00', discountAmount: '1200.00', total: '4800.00', promotionName: 'Launch 20' });
    const inv = (await x.b.post('/invoices', { cycle: 'YEARLY' }).expect(201)).body.data;
    expect(inv).toMatchObject({ total: '4800.00', promotionName: 'Launch 20', discountPercent: 20 });
    await h.http().patch(`/api/v1/admin/billing/promotions/${promo.id}`).set(bearer(superAdmin.access)).send({ isActive: false }).expect(200);
    expect((await x.b.get().expect(200)).body.data.quotes.YEARLY.total).toBe('6000.00'); // new quotes ignore it
    expect((await x.b.get().expect(200)).body.data.openInvoice.total).toBe('4800.00'); // the issued invoice is a snapshot
  });

  it('overview separates platform revenue and lists pending payments', async () => {
    const o = (await admin(finance.access).get('/billing/overview').expect(200)).body.data;
    expect(o.currency).toBe('PKR');
    expect(o.subscriptions).toEqual(expect.objectContaining({ ACTIVE: expect.any(Number), GRACE: expect.any(Number), EXPIRED: expect.any(Number), SUSPENDED: expect.any(Number) }));
    expect(toPaisa(o.verifiedRevenueThisMonth)).toBeGreaterThan(0);
    expect(toPaisa(o.monthlyRecurringRevenue)).toBeGreaterThan(0);
    expect(typeof o.pendingPayments).toBe('number');
  });
});
