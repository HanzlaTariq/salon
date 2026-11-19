import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';
import { EXPENSE_CATEGORIES, ExpenseCategory, REPORT_LIMITS, TREND_GROUPS, TrendGroup } from '../reports.types';

const trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
/** Defence in depth for plain-text fields: no angle brackets and no control characters. */
const SAFE_TEXT = /^[^<>\u0000-\u0008\u000B\u000C\u000E-\u001F]*$/;
const safeText = () => Matches(SAFE_TEXT, { message: '$property contains characters that are not allowed' });
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isoDate = () => Matches(ISO_DATE, { message: '$property must be a date like 2026-11-19' });

/** `from` / `to`: inclusive Asia/Karachi calendar dates. Calendar validity (and "not after today") is checked again in the service. */
export class RangeQuery {
  @IsOptional() @trim() @isoDate() from?: string;
  @IsOptional() @trim() @isoDate() to?: string;
}

export class TrendQuery extends RangeQuery {
  @IsOptional() @IsIn(TREND_GROUPS) group?: TrendGroup;
}

export class ServicesQuery extends RangeQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(REPORT_LIMITS.servicesMax) limit?: number;
}

export class ExpensesQuery extends RangeQuery {
  @IsOptional() @IsIn(EXPENSE_CATEGORIES) category?: ExpenseCategory;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10_000) page?: number;
}

export class AdminTrendQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(REPORT_LIMITS.trendMonthsMax) months?: number;
}

/** Money is always a decimal STRING (never a JSON float). The amount is validated again in the service. */
export class CreateExpenseDto {
  @IsIn(EXPENSE_CATEGORIES) category!: ExpenseCategory;
  @trim() @IsString() @Length(1, 14) amount!: string;
  @trim() @isoDate() expenseDate!: string;
  @IsOptional() @trim() @IsString() @Length(1, 200) @safeText() description?: string;
}

/** PATCH: only the sent fields change. `description: null` clears it. */
export class UpdateExpenseDto {
  @IsOptional() @IsIn(EXPENSE_CATEGORIES) category?: ExpenseCategory;
  @IsOptional() @trim() @IsString() @Length(1, 14) amount?: string;
  @IsOptional() @trim() @isoDate() expenseDate?: string;
  @IsOptional() @trim() @IsString() @Length(1, 200) @safeText() description?: string | null;
}
