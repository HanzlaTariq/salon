import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayUnique, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import {
  CUSTOMER_SORTS, CustomerSort, REPORT_ACTIONS, REPORT_REASONS, REPORT_STATUSES, REVIEW_LIMITS, REVIEW_SORTS, REVIEW_STATUSES, ReportAction, ReportReason, ReportStatus,
  ReviewSort, ReviewStatus,
} from '../reviews.types';

const trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
/** Plain text only: no angle brackets, no control characters (tab and line breaks are allowed). */
const SAFE_TEXT = /^[^<>\u0000-\u0008\u000B\u000C\u000E-\u001F]*$/;
const safeText = () => Matches(SAFE_TEXT, { message: '$property contains characters that are not allowed' });
const TRUE_FALSE = ['true', 'false'] as const;

const stars = () => [IsInt({ message: '$property must be a whole number from 1 to 5' }), Min(1), Max(5)];
function Star() {
  return (target: object, key: string) => stars().forEach((d) => d(target, key));
}

export class ServiceRatingDto {
  @IsUUID() serviceId!: string;
  @Star() rating!: number;
}

/** POST /customers/me/reviews. Salon, staff and visit data come from the appointment, never from the body. */
export class CreateReviewDto {
  @IsUUID() appointmentId!: string;
  @Star() salonRating!: number;
  @IsOptional() @Star() staffRating?: number;
  @IsOptional() @trim() @IsString() @Length(1, REVIEW_LIMITS.commentMax) @safeText() comment?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(REVIEW_LIMITS.maxServiceRatings) @ArrayUnique((s: ServiceRatingDto) => s?.serviceId)
  @ValidateNested({ each: true }) @Type(() => ServiceRatingDto)
  services?: ServiceRatingDto[];
}

/** PATCH /customers/me/reviews/:id. Only the sent fields change; `null` clears the staff rating / comment. */
export class UpdateReviewDto {
  @IsOptional() @Star() salonRating?: number;
  @IsOptional() @Star() staffRating?: number | null;
  @IsOptional() @trim() @IsString() @Length(1, REVIEW_LIMITS.commentMax) @safeText() comment?: string | null;
}

export class PageQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1_000) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(REVIEW_LIMITS.maxPageSize) pageSize?: number;
}

export class PublicReviewsQuery extends PageQuery {
  @IsOptional() @IsIn(REVIEW_SORTS) sort?: ReviewSort;
}

export class OwnerReviewsQuery extends PageQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5) rating?: number;
  @IsOptional() @IsIn(TRUE_FALSE) unanswered?: 'true' | 'false';
  @IsOptional() @IsUUID() staffId?: string;
}

export class RespondDto {
  @trim() @IsString() @Length(1, REVIEW_LIMITS.responseMax) @safeText() text!: string;
}

export class ReportReviewDto {
  @IsIn(REPORT_REASONS) reason!: ReportReason;
  @IsOptional() @trim() @IsString() @Length(3, REVIEW_LIMITS.reportDetailsMax) @safeText() details?: string;
}

export class CustomersQuery extends PageQuery {
  @IsOptional() @trim() @IsString() @MaxLength(80) @safeText() q?: string;
  @IsOptional() @IsIn(CUSTOMER_SORTS) sort?: CustomerSort;
}

export class AdminReviewsQuery extends PageQuery {
  @IsOptional() @IsIn(REVIEW_STATUSES) status?: ReviewStatus;
  @IsOptional() @IsIn(TRUE_FALSE) reported?: 'true' | 'false';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5) rating?: number;
  @IsOptional() @IsUUID() salonId?: string;
}

export class AdminReportsQuery extends PageQuery {
  @IsOptional() @IsIn(REPORT_STATUSES) status?: ReportStatus;
}

export class HideReviewDto {
  @trim() @IsString() @Length(REVIEW_LIMITS.hiddenReasonMin, REVIEW_LIMITS.hiddenReasonMax) @safeText() reason!: string;
}

export class ResolveReportDto {
  @IsIn(REPORT_ACTIONS) action!: ReportAction;
  @IsOptional() @trim() @IsString() @Length(1, REVIEW_LIMITS.noteMax) @safeText() note?: string;
}
