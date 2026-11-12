import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import { BILLING_CYCLES, BillingCycle, PAYMENT_METHODS, PaymentMethodKind, PaymentStatus, Phase } from '../billing.types';

const trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
/** Defence in depth for plain-text fields: no angle brackets and no control characters. */
const SAFE_TEXT = /^[^<>\u0000-\u0008\u000B\u000C\u000E-\u001F]*$/;
const safeText = () => Matches(SAFE_TEXT, { message: '$property contains characters that are not allowed' });
/** Money is always a decimal STRING with at most 2 fraction digits (never a JSON float). */
const MONEY = /^\d{1,8}(\.\d{1,2})?$/;
const money = () => Matches(MONEY, { message: '$property must be an amount like 300 or 300.50' });
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PAYMENT_STATUSES: PaymentStatus[] = ['PENDING', 'NEEDS_INFO', 'APPROVED', 'REJECTED'];
const PHASES: Phase[] = ['NONE', 'ACTIVE', 'GRACE', 'EXPIRED', 'SUSPENDED'];

// ------------------------------------------------------------------ owner
export class CreateInvoiceDto {
  @IsIn(BILLING_CYCLES) cycle!: BillingCycle;
}

/** multipart/form-data fields (the receipt image travels in the "receipt" file part). Amounts are validated again server-side. */
export class SubmitPaymentDto {
  @IsIn(PAYMENT_METHODS) method!: PaymentMethodKind;
  @trim() @IsString() @Matches(/^[A-Za-z0-9][A-Za-z0-9._/-]{3,39}$/, { message: 'transactionId must be 4-40 letters, digits or . _ / -' }) transactionId!: string;
  @trim() @money() claimedAmount!: string;
  @trim() @Matches(ISO_DATE, { message: 'paidOn must be YYYY-MM-DD' }) paidOn!: string;
  @IsOptional() @trim() @IsString() @Length(2, 80) @safeText() senderName?: string;
  @IsOptional() @trim() @IsString() @MaxLength(300) @safeText() note?: string;
}

export class RespondPaymentDto {
  @trim() @IsString() @Length(3, 300) @safeText() note!: string;
  @IsOptional() @trim() @IsString() @Matches(/^[A-Za-z0-9][A-Za-z0-9._/-]{3,39}$/, { message: 'transactionId must be 4-40 letters, digits or . _ / -' }) transactionId?: string;
}

export class PageQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10_000) page?: number;
}

// ------------------------------------------------------------------ admin: configuration
export class CreatePlanDto {
  @trim() @money() monthlyPricePerStaff!: string;
  @trim() @money() yearlyPricePerStaff!: string;
  @Type(() => Number) @IsInt() @Min(0) @Max(60) graceDays!: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(60) renewalNoticeDays!: number;
  /** ISO timestamp, now or later. Omitted = effective immediately. Past values are refused (history is immutable). */
  @IsOptional() @trim() @IsString() @MaxLength(40) effectiveFrom?: string;
  @IsOptional() @trim() @IsString() @MaxLength(300) @safeText() note?: string;
}

export class CreatePromotionDto {
  @trim() @IsString() @Length(2, 80) @safeText() name!: string;
  @trim() @Matches(/^(?:100(?:\.0{1,2})?|\d{1,2}(?:\.\d{1,2})?)$/, { message: 'percentOff must be between 0.01 and 100' }) percentOff!: string;
  @IsIn(['MONTHLY', 'YEARLY', 'ANY']) appliesTo!: BillingCycle | 'ANY';
  @trim() @Matches(ISO_DATE, { message: 'startsOn must be YYYY-MM-DD' }) startsOn!: string;
  @IsOptional() @trim() @Matches(ISO_DATE, { message: 'endsOn must be YYYY-MM-DD' }) endsOn?: string;
}

export class SetActiveDto {
  @IsBoolean() isActive!: boolean;
}

export class CreatePaymentMethodDto {
  @IsIn(PAYMENT_METHODS) method!: PaymentMethodKind;
  @trim() @IsString() @Length(2, 80) @safeText() accountTitle!: string;
  @trim() @IsString() @Length(4, 40) @safeText() accountNumber!: string;
  @IsOptional() @trim() @IsString() @Length(2, 80) @safeText() bankName?: string;
  @IsOptional() @trim() @IsString() @MaxLength(500) @safeText() instructions?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(1000) sortOrder?: number;
}

export class UpdatePaymentMethodDto {
  @IsOptional() @trim() @IsString() @Length(2, 80) @safeText() accountTitle?: string;
  @IsOptional() @trim() @IsString() @Length(4, 40) @safeText() accountNumber?: string;
  @IsOptional() @trim() @IsString() @Length(2, 80) @safeText() bankName?: string | null;
  @IsOptional() @trim() @IsString() @MaxLength(500) @safeText() instructions?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(1000) sortOrder?: number;
}

// ------------------------------------------------------------------ admin: payments and subscriptions
export class AdminPaymentsQuery {
  @IsOptional() @IsIn(PAYMENT_STATUSES) status?: PaymentStatus;
  @IsOptional() @trim() @IsString() @MaxLength(80) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10_000) page?: number;
}

export class ApprovePaymentDto {
  /** The amount the reviewer saw arrive. It must equal the invoice total, which forces a real comparison. */
  @trim() @money() receivedAmount!: string;
}

export class ReviewReasonDto {
  @trim() @IsString() @Length(10, 500) @safeText() reason!: string;
}

export class AdminSubscriptionsQuery {
  @IsOptional() @IsIn(PHASES) phase?: Phase;
  @IsOptional() @trim() @IsString() @MaxLength(80) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10_000) page?: number;
}

export class SubscriptionReasonDto {
  @trim() @IsString() @Length(5, 500) @safeText() reason!: string;
}

export class GrantDto {
  @IsIn(BILLING_CYCLES) cycle!: BillingCycle;
  @trim() @IsString() @Length(5, 300) @safeText() reason!: string;
}
