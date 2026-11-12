import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuthenticatedUser, toTenantContext } from '../../common/auth/authenticated-user';
import { isUniqueViolation } from '../../common/db/pg-errors';
import { AppException } from '../../common/errors/app-exception';
import { ClientContext } from '../../common/http/client-context';
import { ObjectStorage } from '../../common/storage/object-storage';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { processUpload } from '../../common/uploads/process-upload';
import { Clock } from '../../common/util/clock';
import { ENV, Env } from '../../config/env';
import { SalonRecord } from '../salons/salon.types';
import { SalonsRepository, Tx } from '../salons/salons.repository';
import { BillingActor, BillingCore, conflict, planPrices } from './billing-core.service';
import { BillingMailer } from './billing-mailer';
import { BillingRepository, PaymentRecord } from './billing.repository';
import {
  BILLING_LIMITS, BILLING_CYCLES, BillingCycle, addDays, bestPromotion, computeMainInvoice, fromPaisa, isIsoDate, renewalOpensOn, todayKarachi, toPaisa, unitPriceFor,
} from './billing.types';
import { creditView, invoiceView, methodView, ownerPaymentView, subscriptionView } from './billing.views';
import { CreateInvoiceDto, RespondPaymentDto, SubmitPaymentDto } from './dto/billing.dto';

const BILLABLE_SALON_STATUSES = ['APPROVED', 'SUSPENDED'];
const notFound = (what: string) => new AppException('NOT_FOUND', `${what} not found.`, 404);

type UploadedReceipt = { buffer: Buffer; originalname?: string } | undefined;

/** Maps the two payment uniqueness rules to messages that do not reveal which salon used a transaction id. */
function paymentConflict(e: unknown): AppException | null {
  if (!isUniqueViolation(e)) return null;
  const text = `${(e as { message?: unknown })?.message ?? ''} ${JSON.stringify((e as { meta?: unknown })?.meta ?? {})}`;
  if (text.includes('payments_txn_unique_live')) return conflict('This transaction ID has already been submitted. Check the ID, or contact support if it is yours.');
  if (text.includes('payments_one_live_per_invoice')) return conflict('A payment for this invoice is already awaiting review.');
  return conflict('This payment could not be saved. Please try again.');
}

@Injectable()
export class OwnerBillingService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly tenant: TenantDb,
    private readonly salons: SalonsRepository,
    private readonly repo: BillingRepository,
    private readonly core: BillingCore,
    private readonly mailer: BillingMailer,
    private readonly storage: ObjectStorage,
    private readonly clock: Clock,
  ) {}

  /** The owner's salon id comes from the database (owner_user_id = caller), never from the request. */
  private async scoped<T>(user: AuthenticatedUser, write: boolean, fn: (tx: Tx, salon: SalonRecord, now: Date) => Promise<T>): Promise<T> {
    const found = await this.tenant.withTenant(toTenantContext(user), (tx: Tx) => this.salons.findByOwner(tx, user.id));
    if (!found) throw notFound('Salon');
    return this.tenant.withTenant(toTenantContext(user, found.id), async (tx: Tx) => {
      const salon = write ? await this.salons.lockById(tx, found.id) : await this.salons.findById(tx, found.id);
      if (!salon) throw notFound('Salon');
      if (write && !BILLABLE_SALON_STATUSES.includes(salon.status)) throw conflict('Billing starts after your salon is approved.');
      return fn(tx, salon, this.clock.now());
    });
  }

  private actor(user: AuthenticatedUser, meta: ClientContext): BillingActor {
    return { id: user.id, role: user.role, meta };
  }

  // ------------------------------------------------------------------ reads
  async summary(user: AuthenticatedUser) {
    return this.scoped(user, false, async (tx, salon, now) => {
      if (!BILLABLE_SALON_STATUSES.includes(salon.status)) {
        return { eligible: false, message: 'Billing starts after your salon is approved.' };
      }
      const today = todayKarachi(now);
      const [plan, billable, subRec, credit, openMain, openTop, methods, promos, credits] = await Promise.all([
        this.repo.currentPlan(tx, now), this.repo.billableCount(tx, salon.id), this.repo.findSubscription(tx, salon.id), this.repo.creditBalance(tx, salon.id),
        this.repo.findOpenInvoice(tx, salon.id, false), this.repo.findOpenInvoice(tx, salon.id, true), this.repo.listPaymentMethods(tx, true),
        this.repo.listPromotions(tx), this.repo.listCredits(tx, salon.id, 10),
      ]);
      const sub = subscriptionView(subRec, today);

      let quotes: Record<string, unknown> | null = null;
      if (plan && billable >= 1) {
        const prices = planPrices(plan);
        quotes = {};
        for (const cycle of BILLING_CYCLES) {
          const promo = bestPromotion(promos, cycle, today);
          const a = computeMainInvoice({ unitPaisa: unitPriceFor(prices, cycle), staff: billable, discountPercent: promo?.percentOff ?? 0, creditBalancePaisa: toPaisa(credit) });
          quotes[cycle] = {
            cycle, staff: billable, unitPrice: fromPaisa(a.unitPaisa), discountPercent: a.discountPercent, promotionName: promo?.name ?? null,
            subtotal: fromPaisa(a.subtotal), discountAmount: fromPaisa(a.discountAmount), creditApplied: fromPaisa(a.creditApplied), total: fromPaisa(a.total),
          };
        }
      }

      let canCreateInvoice: { allowed: boolean; reason: string | null; opensOn: string | null } = { allowed: true, reason: null, opensOn: null };
      if (subRec?.status === 'SUSPENDED') canCreateInvoice = { allowed: false, reason: 'Your subscription is suspended. Please contact support.', opensOn: null };
      else if (!plan) canCreateInvoice = { allowed: false, reason: 'Subscription pricing has not been configured yet. Please contact support.', opensOn: null };
      else if (openMain) canCreateInvoice = { allowed: false, reason: 'You already have an open invoice.', opensOn: null };
      else if (billable < 1) canCreateInvoice = { allowed: false, reason: 'Add at least one active team member who performs services. The owner counts when they perform services.', opensOn: null };
      else if (subRec && sub.phase === 'ACTIVE') {
        const opens = renewalOpensOn({ status: subRec.status, periodStart: subRec.periodStart, periodEnd: subRec.periodEnd, graceDays: subRec.periodGraceDays }, plan.renewalNoticeDays);
        if (today < opens) canCreateInvoice = { allowed: false, reason: `Renewal opens on ${opens}.`, opensOn: opens };
      }

      return {
        eligible: true,
        currency: 'PKR',
        /** Active staff who perform services: the number you are billed for. */
        billableStaff: billable,
        subscription: sub,
        quotes,
        canCreateInvoice,
        creditBalance: credit,
        recentCredits: credits.map(creditView),
        openInvoice: openMain ? invoiceView(openMain, billable) : null,
        openTopUp: openTop ? invoiceView(openTop, billable) : null,
        paymentMethods: methods.map(methodView),
        pricingConfigured: plan !== null,
      };
    });
  }

  async listInvoices(user: AuthenticatedUser, page: number) {
    return this.scoped(user, false, async (tx, salon) => {
      const size = BILLING_LIMITS.invoicePageSize;
      const [items, billable] = await Promise.all([this.repo.listInvoices(tx, salon.id, size, (page - 1) * size), this.repo.billableCount(tx, salon.id)]);
      return { items: items.map((i) => invoiceView(i, billable)), page, pageSize: size };
    });
  }

  async listPayments(user: AuthenticatedUser) {
    return this.scoped(user, false, async (tx, salon) => {
      const items = await this.repo.listPaymentsForSalon(tx, salon.id, 100);
      return { items: items.map(ownerPaymentView) };
    });
  }

  async receiptUrl(user: AuthenticatedUser, paymentId: string) {
    const p = await this.scoped(user, false, async (tx, salon) => {
      const found = await this.repo.findPayment(tx, paymentId);
      if (!found || found.salonId !== salon.id) throw notFound('Payment');
      return found;
    });
    try {
      return { url: await this.storage.signedUrl(p.receiptKey, this.env.SIGNED_URL_TTL_SEC), expiresInSec: this.env.SIGNED_URL_TTL_SEC };
    } catch {
      throw new AppException('SERVICE_UNAVAILABLE', 'File storage is temporarily unavailable. Please try again.', 503);
    }
  }

  // ------------------------------------------------------------------ writes
  async createInvoice(user: AuthenticatedUser, dto: CreateInvoiceDto, meta: ClientContext) {
    try {
      return await this.scoped(user, true, async (tx, salon, now) => {
        const inv = await this.core.createMainInvoice(tx, salon, this.actor(user, meta), dto.cycle as BillingCycle, now);
        return invoiceView(inv, await this.repo.billableCount(tx, salon.id));
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('You already have an open invoice. Pay it or cancel it first.');
      throw e;
    }
  }

  async cancelInvoice(user: AuthenticatedUser, invoiceId: string, meta: ClientContext) {
    return this.scoped(user, true, async (tx, salon, now) => {
      const inv = await this.repo.findInvoice(tx, invoiceId, { lock: true });
      if (!inv || inv.salonId !== salon.id) throw notFound('Invoice');
      if (inv.kind !== 'INITIAL' && inv.kind !== 'RENEWAL') throw conflict('Top-up invoices follow your team size and cannot be cancelled.');
      await this.core.voidInvoice(tx, inv, 'Cancelled by the owner', this.actor(user, meta), now);
      return { cancelled: true };
    });
  }

  private async storeReceipt(salonId: string, file: UploadedReceipt) {
    if (!file || !file.buffer || file.buffer.length === 0) throw new AppException('VALIDATION_FAILED', 'A receipt image is required (multipart field "receipt").', 400);
    // Images only: re-encoded to WebP (EXIF stripped, polyglots destroyed). PDFs are not accepted as receipts.
    const processed = await processUpload(file.buffer, { allowPdf: false, maxBytes: this.env.UPLOAD_MAX_BYTES });
    const key = `billing/${salonId}/${randomUUID()}.${processed.ext}`; // server-generated; user input never reaches the key
    try {
      await this.storage.put(key, processed.body, processed.contentType);
    } catch {
      throw new AppException('SERVICE_UNAVAILABLE', 'File storage is temporarily unavailable. Please try again.', 503);
    }
    return { key, contentType: processed.contentType, sizeBytes: processed.sizeBytes, sha256: processed.sha256 };
  }

  private async removeQuietly(keys: string[]): Promise<void> {
    await Promise.all(keys.map((k) => this.storage.remove(k).catch(() => undefined)));
  }

  async submitPayment(user: AuthenticatedUser, invoiceId: string, dto: SubmitPaymentDto, file: UploadedReceipt, meta: ClientContext) {
    const found = await this.tenant.withTenant(toTenantContext(user), (tx: Tx) => this.salons.findByOwner(tx, user.id));
    if (!found) throw notFound('Salon');
    const receipt = await this.storeReceipt(found.id, file);
    const paymentId = randomUUID();
    try {
      const out = await this.scoped(user, true, async (tx, salon, now) => {
        const inv = await this.repo.findInvoice(tx, invoiceId, { lock: true });
        if (!inv || inv.salonId !== salon.id) throw notFound('Invoice');
        if (inv.status !== 'OPEN') throw conflict('This invoice is not open for payment.');
        if (toPaisa(inv.total) <= 0) throw conflict('There is nothing to pay on this invoice.');
        if (inv.livePaymentStatus !== null) throw conflict('A payment for this invoice is already awaiting review.');
        if (toPaisa(dto.claimedAmount) !== toPaisa(inv.total)) {
          throw new AppException('VALIDATION_FAILED', `The amount must match the invoice total (Rs. ${inv.total}). Partial payments are not accepted.`, 400);
        }
        const today = todayKarachi(now);
        if (!isIsoDate(dto.paidOn) || dto.paidOn > today || dto.paidOn < addDays(today, -BILLING_LIMITS.paymentMaxAgeDays)) {
          throw new AppException('VALIDATION_FAILED', `paidOn must be a date within the last ${BILLING_LIMITS.paymentMaxAgeDays} days (not in the future).`, 400);
        }
        const methods = await this.repo.listPaymentMethods(tx, true);
        if (!methods.some((m) => m.method === dto.method)) throw new AppException('VALIDATION_FAILED', 'This payment method is not available.', 400);
        await this.repo.insertPayment(tx, {
          id: paymentId, salonId: salon.id, invoiceId: inv.id, method: dto.method, transactionId: dto.transactionId, claimedAmount: inv.total, paidOn: dto.paidOn,
          senderName: dto.senderName ?? null, note: dto.note ?? null, receiptKey: receipt.key, receiptContentType: receipt.contentType, receiptSizeBytes: receipt.sizeBytes,
          receiptSha256: receipt.sha256, submittedBy: user.id,
        });
        await this.core.audit(tx, this.actor(user, meta), salon.id, 'payment.submitted', 'payment', paymentId, { invoiceNo: inv.invoiceNo, method: dto.method, amount: inv.total });
        const stored = (await this.repo.findPayment(tx, paymentId)) as PaymentRecord;
        return { payment: ownerPaymentView(stored), salonName: salon.name, invoiceNo: inv.invoiceNo, amount: inv.total };
      });
      void this.repo.listReviewerContacts().then((r) => this.mailer.paymentSubmitted(r, { salonName: out.salonName, invoiceNo: out.invoiceNo, amount: out.amount })).catch(() => undefined);
      return out.payment;
    } catch (e) {
      await this.removeQuietly([receipt.key]); // never leave an orphan receipt behind
      throw paymentConflict(e) ?? e;
    }
  }

  /** The owner answers a "more information" request: new note, optional corrected transaction id, optional new receipt. */
  async respond(user: AuthenticatedUser, paymentId: string, dto: RespondPaymentDto, file: UploadedReceipt, meta: ClientContext) {
    const found = await this.tenant.withTenant(toTenantContext(user), (tx: Tx) => this.salons.findByOwner(tx, user.id));
    if (!found) throw notFound('Salon');
    const receipt = file && file.buffer && file.buffer.length > 0 ? await this.storeReceipt(found.id, file) : null;
    let oldKey: string | null = null;
    try {
      const out = await this.scoped(user, true, async (tx, salon, now) => {
        const cur = await this.repo.findPayment(tx, paymentId, { lock: true });
        if (!cur || cur.salonId !== salon.id) throw notFound('Payment');
        if (cur.status !== 'NEEDS_INFO') throw conflict('This payment is not waiting for your answer.');
        const ok = await this.repo.respondToInfoRequest(tx, cur.id, { transactionId: dto.transactionId ?? cur.transactionId, note: dto.note, receipt }, now);
        if (!ok) throw conflict('This payment is not waiting for your answer.');
        if (receipt) oldKey = cur.receiptKey;
        await this.core.audit(tx, this.actor(user, meta), salon.id, 'payment.info_provided', 'payment', cur.id, {
          transactionIdChanged: dto.transactionId !== undefined && dto.transactionId !== cur.transactionId, receiptReplaced: receipt !== null,
        });
        return ownerPaymentView((await this.repo.findPayment(tx, cur.id)) as PaymentRecord);
      });
      if (oldKey) await this.removeQuietly([oldKey]);
      return out;
    } catch (e) {
      if (receipt) await this.removeQuietly([receipt.key]);
      throw paymentConflict(e) ?? e;
    }
  }
}
