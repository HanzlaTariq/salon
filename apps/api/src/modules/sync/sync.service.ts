import { Injectable, Logger } from '@nestjs/common';
import { AuthenticatedUser } from '../../common/auth/authenticated-user';
import { isUniqueViolation } from '../../common/db/pg-errors';
import { AppException } from '../../common/errors/app-exception';
import { Clock } from '../../common/util/clock';
import { BookingRepository } from '../booking/booking.repository';
import { Acting, QueueService, Scope } from '../booking/queue.service';
import { QueueRepository } from '../booking/queue.repository';
import { karachiDayBounds } from '../booking/queue.types';
import { queueItemView } from '../booking/queue.views';
import { Tx } from '../salons/salons.repository';
import { PullQuery, PushDto, SyncOperationDto } from './dto/sync.dto';
import { LedgerRecord, SyncRepository } from './sync.repository';
import { ParsedPayload, SYNC_LIMITS, classifyFailure, effectiveActionTime, operationFingerprint, parsePayload } from './sync.types';

const DAY_MS = 86_400_000;
const bad = (message: string) => new AppException('VALIDATION_FAILED', message, 400);
const notFound = (what: string) => new AppException('NOT_FOUND', `${what} not found.`, 404);
const conflict = (message: string, details?: unknown) => new AppException('CONFLICT', message, 409, details);

/** What the app learns about ONE operation. RETRY is never stored: the app simply sends the operation again later. */
export interface OperationResult {
  operationId: string;
  status: 'APPLIED' | 'REJECTED' | 'RETRY';
  /** True when this answer comes from the ledger (the operation had already been processed). */
  replayed: boolean;
  /** The appointment the operation created or changed (the server id: the app replaces its local id with it). */
  appointmentId: string | null;
  code: string | null;
  message: string | null;
}

/**
 * Phase 12: offline sync.
 *
 *  - PUSH replays each offline operation through the SAME QueueService methods as the online endpoints, so permissions, state
 *    machine, grace periods, slot rules, RLS and triggers are exactly the same. The ledger row is written in the SAME transaction
 *    as the change (the `after` hook), so an operation is applied at most once and a crash can never leave it half done.
 *  - A business refusal is FINAL and stored (a replay answers the same and the app shows the reason); a technical failure is not
 *    stored and answers RETRY.
 *  - The server is the authority: it never trusts the device for identity, price, duration, time slot or permissions. The device
 *    clock is only a bounded claim of WHEN the person acted (effectiveActionTime).
 *  - PULL returns the caller's own window (staff: only their own appointments, no phone numbers; owner: the whole salon).
 */
@Injectable()
export class SyncService {
  private readonly log = new Logger(SyncService.name);

  constructor(
    private readonly queue: QueueService,
    private readonly repo: SyncRepository,
    private readonly booking: BookingRepository,
    private readonly queueRepo: QueueRepository,
    private readonly clock: Clock,
  ) {}

  // ------------------------------------------------------------------ push
  async push(user: AuthenticatedUser, dto: PushDto) {
    const ids = dto.operations.map((o) => o.operationId.toLowerCase());
    if (new Set(ids).size !== ids.length) throw bad('An operationId appears twice in this request.');
    const s = await this.queue.resolve(user); // owner or active staff of an APPROVED salon, derived from the session
    const results: OperationResult[] = [];
    // In order: a later operation may depend on an earlier one (complete after start, start after a walk-in).
    // After the first technical failure (RETRY) the rest is NOT attempted: a dependent operation would be refused for good because
    // its predecessor is missing, and a final refusal must never be caused by a hiccup. The app resends them in the same order.
    let halted = false;
    for (const op of dto.operations) {
      if (halted) {
        results.push(this.result(op, { status: 'RETRY', code: 'SKIPPED', message: 'An earlier change could not be applied yet, so this one was not tried.' }));
        continue;
      }
      const r = await this.applyOne(s, op, dto.deviceId);
      if (r.status === 'RETRY') halted = true;
      results.push(r);
    }
    return { serverTime: this.clock.now().toISOString(), results };
  }

  private result(op: SyncOperationDto, r: Partial<OperationResult> & Pick<OperationResult, 'status'>): OperationResult {
    return { operationId: op.operationId, replayed: false, appointmentId: null, code: null, message: null, ...r };
  }

  private fromLedger(op: SyncOperationDto, prior: LedgerRecord, fingerprint: string): OperationResult {
    if (prior.fingerprint !== fingerprint) {
      // The same id for a different action: never apply it, never overwrite the record.
      return this.result(op, { status: 'REJECTED', replayed: true, code: 'IDEMPOTENCY_MISMATCH', message: 'This operation id was already used for a different action.' });
    }
    return this.result(op, { status: prior.status, replayed: true, appointmentId: prior.appointmentId, code: prior.resultCode, message: prior.resultMessage });
  }

  private async applyOne(s: Scope, op: SyncOperationDto, deviceId: string): Promise<OperationResult> {
    const nowMs = this.clock.now().getTime();
    const parsed = parsePayload(op.kind, op.payload);
    const fingerprint = operationFingerprint(op, parsed.ok ? parsed.value : null);
    const { at } = effectiveActionTime(op.createdAt, nowMs);

    const prior = await this.queue.inTx(s, (tx) => this.repo.findOperation(tx, s.salon.id, s.user.id, op.operationId));
    if (prior) return this.fromLedger(op, prior, fingerprint);

    const refused = !parsed.ok ? parsed.message : this.targetProblem(op);
    if (refused) return this.reject(s, op, deviceId, fingerprint, at, { code: 'VALIDATION_FAILED', message: refused });

    try {
      const appointmentId = await this.run(s, op, (parsed as { value: ParsedPayload }).value, deviceId, fingerprint, at);
      return this.result(op, { status: 'APPLIED', appointmentId });
    } catch (e) {
      // A concurrent request (the app retried while the first call was still running) may have applied it a moment ago.
      const again = await this.queue.inTx(s, (tx) => this.repo.findOperation(tx, s.salon.id, s.user.id, op.operationId));
      if (again) return this.fromLedger(op, again, fingerprint);
      const f = classifyFailure(e);
      if (f.retry) {
        this.log.warn(`sync operation ${op.kind} could not be applied now (${e instanceof Error ? e.name : 'error'}); the app will retry`);
        return this.result(op, { status: 'RETRY', code: 'TEMPORARY', message: 'The server could not apply this right now. It will be tried again.' });
      }
      return this.reject(s, op, deviceId, fingerprint, at, { code: f.code, message: f.message });
    }
  }

  /** Exactly one way to name the appointment (or none for a new walk-in). */
  private targetProblem(op: SyncOperationDto): string | null {
    if (op.kind === 'WALK_IN_CREATE') return op.appointmentId || op.refOperationId ? 'A new walk-in cannot name an existing appointment.' : null;
    if (Boolean(op.appointmentId) === Boolean(op.refOperationId)) return 'Name the appointment with exactly one of appointmentId or refOperationId.';
    return null;
  }

  /** Writes a FINAL refusal to the ledger (its own transaction; nothing else changed). */
  private async reject(
    s: Scope, op: SyncOperationDto, deviceId: string, fingerprint: string, at: Date, why: { code: string; message: string },
  ): Promise<OperationResult> {
    try {
      await this.queue.inTx(s, (tx) => this.repo.insertOperation(tx, this.row(s, op, deviceId, fingerprint, at, { status: 'REJECTED', code: why.code, message: why.message, appointmentId: null })));
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      const again = await this.queue.inTx(s, (tx) => this.repo.findOperation(tx, s.salon.id, s.user.id, op.operationId));
      if (again) return this.fromLedger(op, again, fingerprint);
    }
    return this.result(op, { status: 'REJECTED', code: why.code, message: why.message });
  }

  private row(
    s: Scope, op: SyncOperationDto, deviceId: string, fingerprint: string, at: Date,
    o: { status: 'APPLIED' | 'REJECTED'; code: string | null; message: string | null; appointmentId: string | null },
  ) {
    return {
      salonId: s.salon.id, userId: s.user.id, deviceId, operationId: op.operationId, kind: op.kind,
      // A malformed operation may name both; the ledger keeps only the appointment id (the table allows one of the two).
      targetAppointmentId: op.appointmentId ?? null, refOperationId: op.appointmentId ? null : op.refOperationId ?? null, fingerprint,
      clientCreatedAt: new Date(Number.isFinite(Date.parse(op.createdAt)) ? Date.parse(op.createdAt) : at.getTime()), effectiveAt: at,
      status: o.status, resultCode: o.code, resultMessage: o.message, appointmentId: o.appointmentId,
    } as const;
  }

  /** Applies one valid operation. Returns the appointment id. Throws on every refusal (the caller classifies it). */
  private async run(s: Scope, op: SyncOperationDto, p: ParsedPayload, deviceId: string, fingerprint: string, at: Date): Promise<string> {
    // The ledger row, written inside the transaction of the change itself.
    const after: Acting['after'] = (tx, a) =>
      this.repo.insertOperation(tx, this.row(s, op, deviceId, fingerprint, at, { status: 'APPLIED', code: null, message: null, appointmentId: a.id }));
    const acting: Acting = { at, after };

    switch (p.kind) {
      case 'WALK_IN_CREATE': {
        // The operation id doubles as the walk-in's Idempotency-Key (Phase 9): even without the ledger a retry returns the same walk-in.
        const body = { customerName: p.customerName, phone: p.phone ?? undefined, serviceIds: p.serviceIds, note: p.note ?? undefined };
        const out = s.kind === 'OWNER' ? await this.queue.addWalkIn(s.user, { ...body, staffId: p.staffId as string }, op.operationId, acting) : await this.queue.addWalkIn(s.user, body, op.operationId, acting);
        return out.appointment.id;
      }
      case 'APPT_START':
        return (await this.queue.start(s.user, await this.targetId(s, op), acting)).appointment.id;
      case 'APPT_COMPLETE':
        return (await this.queue.complete(s.user, await this.targetId(s, op), acting)).appointment.id;
      case 'APPT_NO_SHOW':
        return (await this.queue.noShow(s.user, await this.targetId(s, op), { reason: p.reason ?? undefined }, acting)).appointment.id;
      case 'NOTE_ADD': {
        const id = await this.targetId(s, op);
        return this.queue.inTx(s, async (tx) => {
          const a = await this.booking.findForSalon(tx, s.salon.id, id, false, s.own?.id ?? null); // staff: only their own appointments
          if (!a) throw notFound('Appointment');
          if ((await this.repo.countNotes(tx, a.id)) >= SYNC_LIMITS.notesPerAppointment) {
            throw conflict('This appointment already has the maximum number of notes.', { rule: 'NOTE_LIMIT', max: SYNC_LIMITS.notesPerAppointment });
          }
          await this.repo.insertNote(tx, { salonId: s.salon.id, appointmentId: a.id, authorUserId: s.user.id, body: p.body });
          await (after as NonNullable<Acting['after']>)(tx, a);
          return a.id;
        });
      }
    }
  }

  /** The appointment an operation is about: its server id, or the walk-in this same user created offline earlier. */
  private async targetId(s: Scope, op: SyncOperationDto): Promise<string> {
    if (op.appointmentId) return op.appointmentId;
    const ref = await this.queue.inTx(s, (tx) => this.repo.findOperation(tx, s.salon.id, s.user.id, op.refOperationId as string));
    if (!ref || ref.kind !== 'WALK_IN_CREATE') throw conflict('The walk-in this action belongs to is not known to the server.', { rule: 'DEPENDENCY_MISSING' });
    if (ref.status !== 'APPLIED' || !ref.appointmentId) throw conflict('The walk-in this action belongs to was refused, so this action cannot be applied.', { rule: 'DEPENDENCY_FAILED' });
    return ref.appointmentId;
  }

  // ------------------------------------------------------------------ pull
  async pull(user: AuthenticatedUser, q: PullQuery) {
    const s = await this.queue.resolve(user);
    const nowMs = this.clock.now().getTime();
    const { dayStart } = karachiDayBounds(nowMs);
    const from = new Date(dayStart.getTime() - SYNC_LIMITS.windowDaysBack * DAY_MS);
    const to = new Date(dayStart.getTime() + SYNC_LIMITS.windowDaysAhead * DAY_MS);

    return this.queue.inTx(s, async (tx: Tx) => {
      const serverTime = await this.repo.serverTime(tx);
      let since: Date | null = null;
      if (q.since) {
        const t = new Date(q.since);
        // A cursor from the future or from long ago is not trusted: the app gets a full snapshot and starts clean.
        if (t.getTime() <= serverTime.getTime() && serverTime.getTime() - t.getTime() <= SYNC_LIMITS.deltaMaxAgeMs) since = new Date(t.getTime() - SYNC_LIMITS.deltaOverlapMs);
      }
      const mode = since ? 'DELTA' : 'FULL';
      const extraIds = since ? await this.repo.appointmentIdsWithNotesSince(tx, s.salon.id, since) : [];
      const staffId = s.kind === 'STAFF' ? (s.own?.id as string) : null;
      const { rows, truncated } = await this.repo.window(tx, s.salon.id, {
        staffId, from, to, since, extraIds, includePhone: s.kind === 'OWNER', limit: SYNC_LIMITS.maxAppointmentsPerPull,
      });
      const ids = rows.map((r) => r.id);
      const lines = await this.booking.linesFor(tx, ids);
      const notes = await this.repo.notesFor(tx, s.salon.id, ids, s.user.id, since);
      const { policy } = await this.booking.getPolicy(tx, s.salon.id);
      // The same view the live queue uses, so the apps read one shape. The early offer and the live forecast are online-only features.
      const appointments = rows.map((a) => queueItemView(a, lines.get(a.id) ?? [], undefined, { position: null, offer: null, policy, nowMs }));

      let catalog: unknown = undefined;
      if (mode === 'FULL' || q.catalog === true) {
        const lanes = await this.queueRepo.lanes(tx, s.salon.id, staffId ? [staffId] : null);
        const staff = [];
        for (const l of lanes) {
          staff.push({
            id: l.id, name: l.name, isOwner: l.isOwner,
            canAddWalkIn: s.kind === 'OWNER' || Boolean(s.own?.permissions.includes('walk_ins.create')),
            services: await this.queueRepo.offeredServices(tx, s.salon.id, l.id),
          });
        }
        catalog = { role: s.kind, ownStaffId: s.own?.id ?? null, noShowGraceMinutes: policy.noShowGraceMinutes, staff };
      }

      return {
        serverTime: serverTime.toISOString(),
        mode,
        window: { from: from.toISOString(), to: to.toISOString() },
        truncated,
        appointments,
        notes: notes.map((n) => ({ id: n.id, appointmentId: n.appointmentId, author: n.authorName, mine: n.mine, body: n.body, createdAt: n.createdAt.toISOString() })),
        ...(catalog ? { catalog } : {}),
      };
    });
  }
}
