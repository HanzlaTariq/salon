import { Injectable } from '@nestjs/common';
import { AuthenticatedUser, toTenantContext } from '../../common/auth/authenticated-user';
import { sqlState } from '../../common/db/pg-errors';
import { AppException } from '../../common/errors/app-exception';
import { ClientContext } from '../../common/http/client-context';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { Clock } from '../../common/util/clock';
import { insertAudit } from '../audit/audit.types';
import { isIsoDate, todayKarachi } from '../billing/billing.types';
import { SalonRecord } from '../salons/salon.types';
import { SalonsRepository, Tx } from '../salons/salons.repository';
import { CreateExpenseDto, ExpensesQuery, UpdateExpenseDto } from './dto/reports.dto';
import { ExpenseRecord, ReportsRepository } from './reports.repository';
import { EXPENSE_IDEMPOTENCY_KEY_RE, REPORT_LIMITS, parseExpenseAmount, resolveRange, sameExpense } from './reports.types';
import { inputGuard, rangeView } from './salon-reports.service';

const notFound = (what: string) => new AppException('NOT_FOUND', `${what} not found.`, 404);
const bad = (message: string) => new AppException('VALIDATION_FAILED', message, 400);
const conflict = (message: string, details?: unknown) => new AppException('CONFLICT', message, 409, details);
const isUniqueViolation = (e: unknown): boolean => sqlState(e) === '23505';

export const expenseView = (e: ExpenseRecord) => ({
  id: e.id, category: e.category, amount: e.amount, expenseDate: e.expenseDate, description: e.description, createdAt: e.createdAt, updatedAt: e.updatedAt,
});

/**
 * Phase 13: the salon's own expenses. SALON_OWNER only; the salon comes from the session. The database repeats the rule in
 * Row-Level Security (owner only: not staff, not customers, not platform admins).
 *
 * Expenses are never hard-deleted (the runtime role has no DELETE): removing one sets `deleted_at`. Every create / change /
 * removal also writes an immutable audit row, so the books cannot be edited silently.
 */
@Injectable()
export class ExpensesService {
  constructor(
    private readonly tenant: TenantDb,
    private readonly repo: ReportsRepository,
    private readonly salons: SalonsRepository,
    private readonly clock: Clock,
  ) {}

  private async scope(u: AuthenticatedUser): Promise<{ salon: SalonRecord; run: <R>(fn: (tx: Tx) => Promise<R>) => Promise<R> }> {
    const salon = await this.tenant.withTenant(toTenantContext(u), (tx: Tx) => this.salons.findByOwner(tx, u.id));
    if (!salon) throw notFound('Salon');
    return { salon, run: (fn) => this.tenant.withTenant(toTenantContext(u, salon.id), fn) };
  }

  private today = (): string => todayKarachi(this.clock.now());

  private audit(tx: Tx, u: AuthenticatedUser, meta: ClientContext, salonId: string, action: string, id: string, metadata: Record<string, unknown>) {
    return insertAudit(tx, {
      actorUserId: u.id, actorRole: u.role, action, targetType: 'salon_expense', targetId: id, salonId,
      ipAddress: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId, metadata,
    });
  }

  private checkDate(date: string): void {
    if (!isIsoDate(date)) throw bad('expenseDate must be a valid calendar date (YYYY-MM-DD).');
    if (date > this.today()) throw bad('An expense cannot be dated in the future.');
    if (date < '2020-01-01') throw bad('expenseDate is too far in the past.');
  }

  // ------------------------------------------------------------------ list
  async list(u: AuthenticatedUser, q: ExpensesQuery) {
    const range = inputGuard(() => resolveRange(q, this.today()));
    const page = q.page ?? 1;
    const { salon, run } = await this.scope(u);
    const r = await run((tx) => this.repo.listExpenses(tx, salon.id, {
      fromDate: range.from, toDate: range.to, category: q.category ?? null, limit: REPORT_LIMITS.expensePageSize, offset: (page - 1) * REPORT_LIMITS.expensePageSize,
    }));
    return {
      currency: 'PKR', range: rangeView(range), page, pageSize: REPORT_LIMITS.expensePageSize, total: r.total, sum: r.sum, items: r.items.map(expenseView),
    };
  }

  // ------------------------------------------------------------------ create (idempotent)
  async create(u: AuthenticatedUser, dto: CreateExpenseDto, key: string | undefined, meta: ClientContext) {
    const amount = inputGuard(() => parseExpenseAmount(dto.amount));
    this.checkDate(dto.expenseDate);
    const description = dto.description ?? null;
    if (dto.category === 'OTHER' && description === null) throw bad('Please describe what this expense was for.');
    if (key !== undefined && !EXPENSE_IDEMPOTENCY_KEY_RE.test(key)) throw bad('Idempotency-Key must be 8-64 letters, digits, "-" or "_".');
    const { salon, run } = await this.scope(u);
    const wanted = { category: dto.category, amount, expenseDate: dto.expenseDate, description };
    const replay = (existing: ExpenseRecord) => {
      if (!sameExpense(existing, wanted)) throw conflict('This Idempotency-Key was already used for a different expense.');
      return { expense: expenseView(existing), replayed: true };
    };
    try {
      return await run(async (tx) => {
        if (key) {
          const existing = await this.repo.findExpenseByKey(tx, salon.id, key);
          if (existing) return replay(existing);
        }
        const row = await this.repo.insertExpense(tx, { salonId: salon.id, ...wanted, idempotencyKey: key ?? null, createdBy: u.id });
        await this.audit(tx, u, meta, salon.id, 'expense.created', row.id, { category: row.category, amount: row.amount, expenseDate: row.expenseDate });
        return { expense: expenseView(row), replayed: false };
      });
    } catch (e) {
      // Two identical retries raced: the loser re-reads the winner's row in a fresh transaction.
      if (key && isUniqueViolation(e)) {
        const existing = await run((tx) => this.repo.findExpenseByKey(tx, salon.id, key));
        if (existing) return replay(existing);
      }
      throw e;
    }
  }

  // ------------------------------------------------------------------ update / delete
  async update(u: AuthenticatedUser, id: string, dto: UpdateExpenseDto, meta: ClientContext) {
    if (dto.category === undefined && dto.amount === undefined && dto.expenseDate === undefined && dto.description === undefined) throw bad('Nothing to change.');
    const amount = dto.amount === undefined ? undefined : inputGuard(() => parseExpenseAmount(dto.amount as string));
    if (dto.expenseDate !== undefined) this.checkDate(dto.expenseDate);
    const { salon, run } = await this.scope(u);
    return run(async (tx) => {
      const before = await this.repo.findExpense(tx, salon.id, id);
      if (!before) throw notFound('Expense');
      const next = {
        category: dto.category ?? before.category,
        amount: amount ?? before.amount,
        expenseDate: dto.expenseDate ?? before.expenseDate,
        description: dto.description === undefined ? before.description : dto.description,
      };
      if (next.category === 'OTHER' && next.description === null) throw bad('Please describe what this expense was for.');
      const row = await this.repo.updateExpense(tx, salon.id, id, next);
      if (!row) throw notFound('Expense');
      await this.audit(tx, u, meta, salon.id, 'expense.updated', row.id, {
        before: { category: before.category, amount: before.amount, expenseDate: before.expenseDate },
        after: { category: row.category, amount: row.amount, expenseDate: row.expenseDate },
      });
      return expenseView(row);
    });
  }

  async remove(u: AuthenticatedUser, id: string, meta: ClientContext): Promise<void> {
    const { salon, run } = await this.scope(u);
    await run(async (tx) => {
      const before = await this.repo.findExpense(tx, salon.id, id);
      if (!before) throw notFound('Expense');
      if (!(await this.repo.softDeleteExpense(tx, salon.id, id, u.id))) throw notFound('Expense');
      await this.audit(tx, u, meta, salon.id, 'expense.deleted', id, { category: before.category, amount: before.amount, expenseDate: before.expenseDate });
    });
  }
}

