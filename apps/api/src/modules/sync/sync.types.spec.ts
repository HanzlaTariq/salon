import { AppException } from '../../common/errors/app-exception';
import { SYNC_LIMITS, classifyFailure, effectiveActionTime, operationFingerprint, parsePayload } from './sync.types';

const U1 = '3f0c7f0e-8d1a-4b8e-9c55-0a1b2c3d4e5f';
const U2 = '7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const NOW = Date.UTC(2026, 10, 17, 10, 0, 0);

describe('effectiveActionTime', () => {
  it('keeps a plausible offline time as it is', () => {
    const r = effectiveActionTime(new Date(NOW - 30 * 60_000).toISOString(), NOW);
    expect(r.at.getTime()).toBe(NOW - 30 * 60_000);
    expect(r.clamped).toBe(false);
  });
  it('never lets a device write the future', () => {
    const r = effectiveActionTime(new Date(NOW + 3 * 3_600_000).toISOString(), NOW);
    expect(r.at.getTime()).toBe(NOW);
    expect(r.clamped).toBe(true);
  });
  it('clamps a time older than the offline limit', () => {
    const r = effectiveActionTime(new Date(NOW - 10 * 24 * 3_600_000).toISOString(), NOW);
    expect(r.at.getTime()).toBe(NOW - SYNC_LIMITS.maxOfflineHours * 3_600_000);
    expect(r.clamped).toBe(true);
  });
  it('treats garbage as "now"', () => {
    expect(effectiveActionTime('not a date', NOW).at.getTime()).toBe(NOW);
  });
});

describe('parsePayload', () => {
  it('accepts start / complete without a payload', () => {
    expect(parsePayload('APPT_START', undefined)).toEqual({ ok: true, value: { kind: 'APPT_START' } });
    expect(parsePayload('APPT_COMPLETE', null)).toEqual({ ok: true, value: { kind: 'APPT_COMPLETE' } });
  });
  it('validates a no-show reason and a note', () => {
    expect(parsePayload('APPT_NO_SHOW', {})).toEqual({ ok: true, value: { kind: 'APPT_NO_SHOW', reason: null } });
    expect(parsePayload('APPT_NO_SHOW', { reason: '  did not come ' })).toEqual({ ok: true, value: { kind: 'APPT_NO_SHOW', reason: 'did not come' } });
    expect(parsePayload('APPT_NO_SHOW', { reason: '<script>' }).ok).toBe(false);
    expect(parsePayload('NOTE_ADD', { body: '' }).ok).toBe(false);
    expect(parsePayload('NOTE_ADD', { body: 'x'.repeat(SYNC_LIMITS.noteMaxLength + 1) }).ok).toBe(false);
    expect(parsePayload('NOTE_ADD', { body: 'Wants a fade' })).toEqual({ ok: true, value: { kind: 'NOTE_ADD', body: 'Wants a fade' } });
  });
  it('validates a walk-in and ignores any price or duration the device sends', () => {
    const ok = parsePayload('WALK_IN_CREATE', { customerName: ' Bilal ', serviceIds: [U1], phone: '0300 1234567', price: 1, durationMinutes: 1 });
    expect(ok).toEqual({ ok: true, value: { kind: 'WALK_IN_CREATE', staffId: null, customerName: 'Bilal', phone: '0300 1234567', serviceIds: [U1], note: null } });
    expect(parsePayload('WALK_IN_CREATE', { customerName: 'B', serviceIds: [U1] }).ok).toBe(false);
    expect(parsePayload('WALK_IN_CREATE', { customerName: 'Bilal', serviceIds: [] }).ok).toBe(false);
    expect(parsePayload('WALK_IN_CREATE', { customerName: 'Bilal', serviceIds: [U1, U1] }).ok).toBe(false);
    expect(parsePayload('WALK_IN_CREATE', { customerName: 'Bilal', serviceIds: ['nope'] }).ok).toBe(false);
    expect(parsePayload('WALK_IN_CREATE', { customerName: 'Bilal', serviceIds: [U1], staffId: 'x' }).ok).toBe(false);
  });
});

describe('operationFingerprint', () => {
  const base = { operationId: U1, kind: 'APPT_START' as const, createdAt: '2026-11-17T09:00:00Z', appointmentId: U2 };
  it('is the same for a retry (other timestamp, same meaning)', () => {
    const a = operationFingerprint(base, { kind: 'APPT_START' });
    const b = operationFingerprint({ ...base, createdAt: '2026-11-17T09:30:00Z' }, { kind: 'APPT_START' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it('changes when the meaning changes', () => {
    expect(operationFingerprint(base, { kind: 'APPT_START' })).not.toBe(operationFingerprint({ ...base, appointmentId: U1 }, { kind: 'APPT_START' }));
    expect(operationFingerprint(base, { kind: 'APPT_START' })).not.toBe(operationFingerprint({ ...base, kind: 'APPT_COMPLETE' }, { kind: 'APPT_COMPLETE' }));
  });
  it('does not depend on the order of the services of a walk-in', () => {
    const w = (ids: string[]) => operationFingerprint({ operationId: U1, kind: 'WALK_IN_CREATE', createdAt: base.createdAt }, { kind: 'WALK_IN_CREATE', staffId: null, customerName: 'Bilal', phone: null, serviceIds: ids, note: null });
    expect(w([U1, U2])).toBe(w([U2, U1]));
  });
});

describe('classifyFailure', () => {
  it('a business refusal (4xx) is final and keeps the rule name', () => {
    const f = classifyFailure(new AppException('CONFLICT', 'Nope', 409, { rule: 'NO_SHOW_GRACE' }));
    expect(f).toMatchObject({ retry: false, code: 'NO_SHOW_GRACE', message: 'Nope' });
    expect(classifyFailure(new AppException('NOT_FOUND', 'x', 404))).toMatchObject({ retry: false, code: 'NOT_FOUND' });
  });
  it('a server error or an unknown error is retried, never stored', () => {
    expect(classifyFailure(new AppException('INTERNAL_ERROR', 'x', 500))).toEqual({ retry: true });
    expect(classifyFailure(new Error('connection reset'))).toEqual({ retry: true });
    expect(classifyFailure({ code: '40001' })).toEqual({ retry: true });
  });
  it('a database rule that escaped is final', () => {
    expect(classifyFailure({ code: '23P01' })).toMatchObject({ retry: false, code: 'SLOT_TAKEN' });
    expect(classifyFailure({ code: '23514' })).toMatchObject({ retry: false, code: 'DB_RULE' });
  });
});
