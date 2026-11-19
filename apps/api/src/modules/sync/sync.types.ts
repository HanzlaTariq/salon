import { createHash } from 'crypto';
import { sqlState } from '../../common/db/pg-errors';
import { AppException } from '../../common/errors/app-exception';
import { BOOKING_LIMITS } from '../booking/booking.types';
import { QUEUE_LIMITS } from '../booking/queue.types';

const HOUR_MS = 3_600_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_TEXT = /^[^<>\u0000-\u0008\u000B\u000C\u000E-\u001F]*$/;

export const SYNC_LIMITS = {
  /** Operations per push. Each one is its own transaction, so the batch stays small and a timeout loses little work. */
  maxOperationsPerPush: 25,
  /**
   * An offline action is recorded at the moment the person really did it, but never in the future and never older than this.
   * Matches the 48-hour walk-in rule of the database (migration 20261119000000).
   */
  maxOfflineHours: 48,
  noteMaxLength: 500,
  notesPerAppointment: 30,
  /** The cached window: from yesterday to a week ahead (Karachi days). */
  windowDaysBack: 1,
  windowDaysAhead: 8,
  /** Hard cap of appointments per pull. When it is hit the response says `truncated: true` (never silently). */
  maxAppointmentsPerPull: 500,
  /** A delta pull re-reads this much before the client's cursor, so a slow transaction that committed late is never missed. */
  deltaOverlapMs: 10_000,
  /** A cursor older than this is not trusted: the pull becomes a full snapshot. */
  deltaMaxAgeMs: 7 * 24 * HOUR_MS,
} as const;

export const SYNC_KINDS = ['APPT_START', 'APPT_COMPLETE', 'APPT_NO_SHOW', 'WALK_IN_CREATE', 'NOTE_ADD'] as const;
export type SyncKind = (typeof SYNC_KINDS)[number];

export type SyncStatus = 'APPLIED' | 'REJECTED';

/** One operation exactly as the app sends it (the envelope is validated by the DTO, the payload by `parsePayload`). */
export interface SyncOperationInput {
  operationId: string;
  kind: SyncKind;
  /** The device clock when the person acted. Informational and bounded: the server decides the recorded time (see effectiveActionTime). */
  createdAt: string;
  /** The server id of the appointment (for appointments that already exist on the server). */
  appointmentId?: string;
  /** Instead of `appointmentId`: the operation id of a WALK_IN_CREATE that was written offline (the app does not know the server id yet). */
  refOperationId?: string;
  payload?: Record<string, unknown>;
}

export type ParsedPayload =
  | { kind: 'APPT_START' | 'APPT_COMPLETE' }
  | { kind: 'APPT_NO_SHOW'; reason: string | null }
  | { kind: 'WALK_IN_CREATE'; staffId: string | null; customerName: string; phone: string | null; serviceIds: string[]; note: string | null }
  | { kind: 'NOTE_ADD'; body: string };

export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const text = (v: unknown, min: number, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length >= min && t.length <= max && SAFE_TEXT.test(t) ? t : null;
};

/**
 * Validates the payload of ONE operation. A bad payload rejects that operation only (VALIDATION_FAILED), never the whole batch.
 * Prices, durations and service names are never accepted: the server derives them from the catalogue.
 */
export function parsePayload(kind: SyncKind, raw: unknown): { ok: true; value: ParsedPayload } | { ok: false; message: string } {
  const p = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  switch (kind) {
    case 'APPT_START':
    case 'APPT_COMPLETE':
      return { ok: true, value: { kind } };
    case 'APPT_NO_SHOW': {
      if (p.reason === undefined || p.reason === null || p.reason === '') return { ok: true, value: { kind, reason: null } };
      const reason = text(p.reason, 1, BOOKING_LIMITS.reasonMaxLength);
      return reason ? { ok: true, value: { kind, reason } } : { ok: false, message: 'The reason is not valid.' };
    }
    case 'NOTE_ADD': {
      const body = text(p.body, 1, SYNC_LIMITS.noteMaxLength);
      return body ? { ok: true, value: { kind, body } } : { ok: false, message: `A note needs 1 to ${SYNC_LIMITS.noteMaxLength} characters.` };
    }
    case 'WALK_IN_CREATE': {
      const customerName = text(p.customerName, QUEUE_LIMITS.walkInNameMinLength, QUEUE_LIMITS.walkInNameMaxLength);
      if (!customerName) return { ok: false, message: 'The customer name is not valid.' };
      const ids = p.serviceIds;
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > BOOKING_LIMITS.maxServices || !ids.every(isUuid) || new Set(ids).size !== ids.length) {
        return { ok: false, message: 'Choose between 1 and the allowed number of different services.' };
      }
      const phone = p.phone === undefined || p.phone === null || p.phone === '' ? null : text(p.phone, 1, 20);
      if (p.phone !== undefined && p.phone !== null && p.phone !== '' && phone === null) return { ok: false, message: 'The phone number is not valid.' };
      const note = p.note === undefined || p.note === null || p.note === '' ? null : text(p.note, 1, QUEUE_LIMITS.walkInNoteMaxLength);
      if (p.note !== undefined && p.note !== null && p.note !== '' && note === null) return { ok: false, message: 'The note is not valid.' };
      const staffId = p.staffId === undefined || p.staffId === null ? null : isUuid(p.staffId) ? p.staffId : undefined;
      if (staffId === undefined) return { ok: false, message: 'staffId is not valid.' };
      return { ok: true, value: { kind, staffId, customerName, phone, serviceIds: ids as string[], note } };
    }
    default:
      return { ok: false, message: 'Unknown operation.' };
  }
}

/** Stable SHA-256 of what the operation MEANS (not of its timestamps). A retry has the same fingerprint; a re-used id for something else does not. */
export function operationFingerprint(op: SyncOperationInput, parsed: ParsedPayload | null): string {
  const canonical = JSON.stringify([
    op.kind, op.appointmentId ?? '', op.refOperationId ?? '',
    parsed ? (parsed.kind === 'WALK_IN_CREATE' ? [parsed.staffId ?? '', [...parsed.serviceIds].sort(), parsed.customerName, parsed.phone ?? '', parsed.note ?? ''] : parsed.kind === 'NOTE_ADD' ? parsed.body : parsed.kind === 'APPT_NO_SHOW' ? parsed.reason ?? '' : '') : '',
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * When did the person REALLY act? The device clock is a claim, not a fact:
 *  - never later than the server's own clock (nobody can write the future);
 *  - never older than `maxOfflineHours` (a device that was offline for days is clamped, and the ledger keeps the original claim);
 *  - an unreadable timestamp means "now".
 * Because the result is never later than the server clock, a lying device can only make a rule STRICTER for itself (a no-show
 * grace period is judged at the claimed moment, a start is judged against the 60-minute early limit at the claimed moment).
 */
export function effectiveActionTime(createdAtIso: string, nowMs: number): { at: Date; clamped: boolean } {
  const claimed = Date.parse(createdAtIso);
  if (!Number.isFinite(claimed)) return { at: new Date(nowMs), clamped: true };
  const floor = nowMs - SYNC_LIMITS.maxOfflineHours * HOUR_MS;
  const at = Math.min(nowMs, Math.max(floor, claimed));
  return { at: new Date(at), clamped: at !== claimed };
}

export type FailureClass = { retry: true } | { retry: false; code: string; message: string; details?: unknown };

/**
 * A business refusal (a 4xx AppException) is FINAL: it is written to the ledger so a replay answers the same, and the app shows it
 * to the person. Everything else (a 5xx, a lost connection, a lock timeout, a bug) is NOT recorded: the app simply tries again.
 */
export function classifyFailure(e: unknown): FailureClass {
  if (e instanceof AppException) {
    const status = e.getStatus();
    if (status >= 400 && status < 500) {
      const details = e.details as { rule?: unknown } | undefined;
      const rule = details && typeof details.rule === 'string' ? details.rule : null;
      return { retry: false, code: (rule ?? e.code).slice(0, 40), message: e.message.slice(0, 300), details: e.details };
    }
    return { retry: true };
  }
  // A check / exclusion / unique violation that escaped the services is a rule of the database: also final, never retried forever.
  const state = sqlState(e);
  if (state === '23P01') return { retry: false, code: 'SLOT_TAKEN', message: 'That time was just taken.' };
  if (state === '23514' || state === '42501') return { retry: false, code: 'DB_RULE', message: 'The database refused this change.' };
  return { retry: true };
}
