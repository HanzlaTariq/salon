import { renderNotification, TemplateParams } from './notification.templates';
import { LANGUAGES, NOTIFICATION_TYPES } from './notification.types';

const T = Date.UTC(2026, 10, 16, 10, 5); // Mon 16 Nov 2026, 3:05 PM in Karachi
const FULL: TemplateParams = {
  salon: 'Glow Studio', staff: 'Ali', customer: 'Sara', startsAtMs: T, estimateMs: T + 20 * 60_000, oldStartsAtMs: T, newStartsAtMs: T - 30 * 60_000,
  offeredMs: T - 25 * 60_000, etaMs: T + 600_000, minutes: 20, reason: 'Documents unclear', invoiceNo: 'INV-000012', days: 3, periodEnd: '2026-12-13', graceEnd: '2026-12-16',
};

describe('Phase 10 templates', () => {
  it('every notification type renders in English and Urdu within the database length limits', () => {
    for (const type of NOTIFICATION_TYPES) {
      for (const lang of LANGUAGES) {
        const r = renderNotification(type, lang, FULL);
        expect(r.title.length).toBeGreaterThan(0);
        expect(r.title.length).toBeLessThanOrEqual(120);
        expect(r.body.length).toBeGreaterThan(0);
        expect(r.body.length).toBeLessThanOrEqual(300);
        expect(`${r.title} ${r.body}`).not.toMatch(/undefined|NaN|\[object/);
      }
    }
  });
  it('Urdu texts contain Urdu script', () => {
    for (const type of NOTIFICATION_TYPES) expect(renderNotification(type, 'ur', FULL).title).toMatch(/[\u0600-\u06FF]/);
  });
  it('the early offer asks the exact question and keeps the booked time', () => {
    const r = renderNotification('EARLY_OFFER', 'en', FULL);
    expect(r.title).toBe('Your stylist is available earlier');
    expect(r.body).toContain('Would you like to come now?');
    expect(r.body).toContain('2:40 PM');
    expect(r.body).toContain('3:05 PM');
  });
  it('a delay notice shows the new estimate next to the booked time', () => {
    const r = renderNotification('DELAY_NOTICE', 'en', FULL);
    expect(r.body).toContain('3:25 PM');
    expect(r.body).toContain('3:05 PM');
    expect(r.body).toContain('20 min');
  });
  it('the reminder at the appointment time says "please leave", earlier ones say how many minutes', () => {
    expect(renderNotification('APPOINTMENT_REMINDER', 'en', { ...FULL, minutes: 0 }).title).toBe('Please leave for the salon');
    expect(renderNotification('APPOINTMENT_REMINDER', 'en', { ...FULL, minutes: 30 }).title).toBe('Appointment in 30 minutes');
  });
  it('names typed by people are cleaned and shortened', () => {
    const r = renderNotification('BOOKING_NEW', 'en', { ...FULL, customer: `Sara\n${'x'.repeat(200)}` });
    expect(r.body).not.toContain('\n');
    expect(r.body.length).toBeLessThanOrEqual(300);
  });
  it('missing names fall back to neutral words', () => {
    expect(renderNotification('BOOKING_NEW', 'en', { startsAtMs: T }).body).toContain('A customer');
    expect(renderNotification('SERVICE_COMPLETED', 'ur', {}).body).toContain('سیلون');
  });
  it('subscription notices read well for 1 day and with or without a grace period', () => {
    expect(renderNotification('SUBSCRIPTION_EXPIRING', 'en', { days: 1, periodEnd: '2026-12-13' }).title).toBe('Subscription ends tomorrow');
    expect(renderNotification('SUBSCRIPTION_EXPIRED', 'en', { graceEnd: '2026-12-16' }).body).toContain('grace period');
    expect(renderNotification('SUBSCRIPTION_EXPIRED', 'en', { graceEnd: null }).body).toContain('Renew now');
  });
});
