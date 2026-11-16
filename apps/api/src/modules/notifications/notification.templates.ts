import { Language, NotificationType, clean, isoDateLabel, timeLabel, whenLabel } from './notification.types';

/**
 * English and Urdu texts. A template only receives facts (names, times, minutes) and builds a short title and body; it never
 * decides who is notified or whether. Names and reasons are typed by people, so they are cleaned and shortened first.
 * Times are always written in Pakistan time (Asia/Karachi).
 */
export interface TemplateParams {
  salon?: string | null;
  staff?: string | null;
  customer?: string | null;
  /** The booked time of the appointment (ms). */
  startsAtMs?: number;
  /** The salon's forecast when the day runs late (ms). */
  estimateMs?: number;
  oldStartsAtMs?: number;
  newStartsAtMs?: number;
  /** The earlier time offered to the customer (ms). */
  offeredMs?: number;
  /** The time the customer says they will arrive (ms). */
  etaMs?: number;
  /** Reminder offset, delay in minutes, or "coming in N minutes". */
  minutes?: number;
  reason?: string | null;
  invoiceNo?: string | null;
  days?: number;
  /** "YYYY-MM-DD" (Karachi calendar date). */
  periodEnd?: string;
  graceEnd?: string | null;
}

export interface Rendered {
  title: string;
  body: string;
}

interface Text {
  title: string;
  body: string;
}

/** Parameters after cleaning (everything has a safe value). */
interface Norm {
  salon: string;
  staff: string;
  customer: string;
  reason: string;
  invoiceNo: string;
  minutes: number;
  days: number;
  p: TemplateParams;
}

const n = (p: TemplateParams): Norm => ({
  salon: clean(p.salon, 60) || 'the salon',
  staff: clean(p.staff, 40) || 'your stylist',
  customer: clean(p.customer, 40) || 'A customer',
  reason: clean(p.reason, 120),
  invoiceNo: clean(p.invoiceNo, 24),
  minutes: p.minutes ?? 0,
  days: p.days ?? 0,
  p,
});

const urSalon = (x: Norm): string => (x.salon === 'the salon' ? 'سیلون' : x.salon);
const urStaff = (x: Norm): string => (x.staff === 'your stylist' ? 'آپ کا اسٹائلسٹ' : x.staff);
const urCustomer = (x: Norm): string => (x.customer === 'A customer' ? 'ایک گاہک' : x.customer);
const t = (ms: number | undefined, l: Language): string => (ms === undefined ? '' : timeLabel(ms, l));
const w = (ms: number | undefined, l: Language): string => (ms === undefined ? '' : whenLabel(ms, l));
const withReason = (r: string): string => (r ? `: ${r}` : '');

const TEMPLATES: Record<NotificationType, (x: Norm) => Record<Language, Text>> = {
  BOOKING_CONFIRMED: (x) => ({
    en: { title: 'Booking confirmed', body: `${x.salon} with ${x.staff}, ${w(x.p.startsAtMs, 'en')}.` },
    ur: { title: 'بکنگ کنفرم ہو گئی', body: `${urSalon(x)} میں ${x.staff} کے ساتھ، ${w(x.p.startsAtMs, 'ur')}۔` },
  }),
  BOOKING_NEW: (x) => ({
    en: { title: 'New booking', body: `${x.customer} booked ${x.staff}, ${w(x.p.startsAtMs, 'en')}.` },
    ur: { title: 'نئی بکنگ', body: `${urCustomer(x)} نے ${x.staff} کے ساتھ ${w(x.p.startsAtMs, 'ur')} کی بکنگ کی ہے۔` },
  }),
  BOOKING_CANCELLED_SALON: (x) => ({
    en: { title: 'Booking cancelled by the salon', body: `${x.salon} cancelled your appointment on ${w(x.p.startsAtMs, 'en')}${withReason(x.reason)}.` },
    ur: { title: 'سیلون نے بکنگ منسوخ کر دی', body: `${urSalon(x)} نے ${w(x.p.startsAtMs, 'ur')} کی آپ کی اپائنٹمنٹ منسوخ کر دی ہے${withReason(x.reason)}۔` },
  }),
  BOOKING_CANCELLED_STAFF: (x) => ({
    en: { title: 'Appointment cancelled', body: `${x.customer}'s appointment with ${x.staff} on ${w(x.p.startsAtMs, 'en')} was cancelled${withReason(x.reason)}.` },
    ur: { title: 'اپائنٹمنٹ منسوخ', body: `${urCustomer(x)} کی ${x.staff} کے ساتھ ${w(x.p.startsAtMs, 'ur')} کی اپائنٹمنٹ منسوخ ہو گئی ہے${withReason(x.reason)}۔` },
  }),
  BOOKING_RESCHEDULED: (x) => ({
    en: { title: 'Appointment rescheduled', body: `${x.customer} moved the appointment with ${x.staff} from ${w(x.p.oldStartsAtMs, 'en')} to ${w(x.p.newStartsAtMs, 'en')}.` },
    ur: { title: 'اپائنٹمنٹ کا وقت بدل گیا', body: `${urCustomer(x)} نے ${x.staff} کے ساتھ اپائنٹمنٹ ${w(x.p.oldStartsAtMs, 'ur')} سے ${w(x.p.newStartsAtMs, 'ur')} پر منتقل کر دی ہے۔` },
  }),
  APPOINTMENT_REMINDER: (x) =>
    x.minutes > 0
      ? {
          en: { title: `Appointment in ${x.minutes} minutes`, body: `${x.salon} with ${x.staff} at ${t(x.p.estimateMs ?? x.p.startsAtMs, 'en')}. Open to tell the salon you are coming.` },
          ur: { title: `اپائنٹمنٹ ${x.minutes} منٹ میں`, body: `${urSalon(x)} میں ${x.staff} کے ساتھ ${t(x.p.estimateMs ?? x.p.startsAtMs, 'ur')} بجے۔ سیلون کو اپنی آمد بتانے کے لیے کھولیں۔` },
        }
      : {
          en: { title: 'Please leave for the salon', body: `Your appointment at ${x.salon} is now. Open to tell them you are on your way.` },
          ur: { title: 'براہِ کرم سیلون کے لیے روانہ ہوں', body: `${urSalon(x)} میں آپ کی اپائنٹمنٹ کا وقت ہو گیا ہے۔ روانگی کی اطلاع دینے کے لیے کھولیں۔` },
        },
  EARLY_OFFER: (x) => ({
    en: { title: 'Your stylist is available earlier', body: `Would you like to come now? ${x.staff} can see you at ${t(x.p.offeredMs, 'en')} (booked: ${t(x.p.startsAtMs, 'en')}). Your booked time stays unless you accept.` },
    ur: { title: 'آپ کا اسٹائلسٹ پہلے دستیاب ہے', body: `کیا آپ ابھی آنا چاہیں گے؟ ${x.staff} ${t(x.p.offeredMs, 'ur')} پر دستیاب ہیں (آپ کا وقت: ${t(x.p.startsAtMs, 'ur')})۔ قبول نہ کریں تو آپ کا وقت وہی رہے گا۔` },
  }),
  EARLY_ACCEPTED: (x) => ({
    en: { title: 'Customer is coming earlier', body: `${x.customer} accepted the earlier time (${t(x.p.newStartsAtMs, 'en')})${x.minutes > 0 ? `, arriving in about ${x.minutes} min` : ''}.` },
    ur: { title: 'گاہک جلدی آ رہا ہے', body: `${urCustomer(x)} نے پہلے کا وقت (${t(x.p.newStartsAtMs, 'ur')}) قبول کر لیا ہے${x.minutes > 0 ? `، تقریباً ${x.minutes} منٹ میں پہنچیں گے` : ''}۔` },
  }),
  EARLY_DECLINED: (x) => ({
    en: { title: 'Customer keeps the booked time', body: `${x.customer} will keep the ${t(x.p.startsAtMs, 'en')} appointment.` },
    ur: { title: 'گاہک اپنا وقت رکھے گا', body: `${urCustomer(x)} ${t(x.p.startsAtMs, 'ur')} کی اپائنٹمنٹ برقرار رکھیں گے۔` },
  }),
  ARRIVAL_ON_THE_WAY: (x) => ({
    en: { title: 'Customer is on the way', body: `${x.customer} is on the way${x.minutes > 0 ? ` (about ${x.minutes} min)` : ''}. Booked: ${t(x.p.startsAtMs, 'en')}.` },
    ur: { title: 'گاہک راستے میں ہے', body: `${urCustomer(x)} راستے میں ہیں${x.minutes > 0 ? ` (تقریباً ${x.minutes} منٹ)` : ''}۔ بکنگ: ${t(x.p.startsAtMs, 'ur')}۔` },
  }),
  ARRIVAL_RUNNING_LATE: (x) => ({
    en: { title: 'Customer will be late', body: `${x.customer} will be late${x.p.etaMs ? `, expected around ${t(x.p.etaMs, 'en')}` : ''}. Booked: ${t(x.p.startsAtMs, 'en')}.` },
    ur: { title: 'گاہک دیر سے آئے گا', body: `${urCustomer(x)} دیر سے پہنچیں گے${x.p.etaMs ? `، تقریباً ${t(x.p.etaMs, 'ur')} تک` : ''}۔ بکنگ: ${t(x.p.startsAtMs, 'ur')}۔` },
  }),
  DELAY_NOTICE: (x) => ({
    en: { title: 'Your appointment is running late', body: `${x.salon} is about ${x.minutes} min behind. New estimate: ${t(x.p.estimateMs, 'en')} (booked: ${t(x.p.startsAtMs, 'en')}).` },
    ur: { title: 'آپ کی اپائنٹمنٹ میں تاخیر ہے', body: `${urSalon(x)} میں تقریباً ${x.minutes} منٹ کی تاخیر ہے۔ نیا تخمینہ: ${t(x.p.estimateMs, 'ur')} (بکنگ: ${t(x.p.startsAtMs, 'ur')})۔` },
  }),
  SERVICE_COMPLETED: (x) => ({
    en: { title: 'Service completed', body: `Thank you for visiting ${x.salon}.` },
    ur: { title: 'سروس مکمل', body: `${urSalon(x)} آنے کا شکریہ۔` },
  }),
  NO_SHOW_RECORDED: (x) => ({
    en: { title: 'Appointment marked as missed', body: `${x.salon} marked your ${w(x.p.startsAtMs, 'en')} appointment as a no-show.` },
    ur: { title: 'اپائنٹمنٹ چھوٹ گئی', body: `${urSalon(x)} نے ${w(x.p.startsAtMs, 'ur')} کی آپ کی اپائنٹمنٹ کو غیر حاضری شمار کیا ہے۔` },
  }),
  SALON_APPROVED: (x) => ({
    en: { title: 'Your salon is approved', body: `${x.salon} is now live and can receive bookings.` },
    ur: { title: 'آپ کا سیلون منظور ہو گیا', body: `${urSalon(x)} اب لائیو ہے اور بکنگز وصول کر سکتا ہے۔` },
  }),
  SALON_REJECTED: (x) => ({
    en: { title: 'Salon application not approved', body: `${x.salon}${withReason(x.reason)}. Please correct the details and submit again.` },
    ur: { title: 'سیلون کی درخواست منظور نہیں ہوئی', body: `${urSalon(x)}${withReason(x.reason)}۔ براہِ کرم تفصیلات درست کر کے دوبارہ جمع کروائیں۔` },
  }),
  SALON_SUSPENDED: (x) => ({
    en: { title: 'Your salon is suspended', body: `${x.salon} is suspended${withReason(x.reason)}. Please contact support.` },
    ur: { title: 'آپ کا سیلون معطل کر دیا گیا ہے', body: `${urSalon(x)} معطل ہے${withReason(x.reason)}۔ براہِ کرم سپورٹ سے رابطہ کریں۔` },
  }),
  SALON_REACTIVATED: (x) => ({
    en: { title: 'Your salon is active again', body: `${x.salon} can receive bookings again.` },
    ur: { title: 'آپ کا سیلون دوبارہ فعال ہے', body: `${urSalon(x)} دوبارہ بکنگز وصول کر سکتا ہے۔` },
  }),
  PAYMENT_APPROVED: (x) => ({
    en: { title: 'Payment verified', body: `Your payment for invoice ${x.invoiceNo} was verified. Your subscription is up to date.` },
    ur: { title: 'ادائیگی کی تصدیق ہو گئی', body: `انوائس ${x.invoiceNo} کی ادائیگی کی تصدیق ہو گئی ہے۔ آپ کی سبسکرپشن اپ ٹو ڈیٹ ہے۔` },
  }),
  PAYMENT_REJECTED: (x) => ({
    en: { title: 'Payment rejected', body: `Invoice ${x.invoiceNo}${withReason(x.reason)}` },
    ur: { title: 'ادائیگی مسترد', body: `انوائس ${x.invoiceNo}${withReason(x.reason)}` },
  }),
  PAYMENT_NEEDS_INFO: (x) => ({
    en: { title: 'More payment information needed', body: `Invoice ${x.invoiceNo}${withReason(x.reason)}` },
    ur: { title: 'ادائیگی کی مزید معلومات درکار ہیں', body: `انوائس ${x.invoiceNo}${withReason(x.reason)}` },
  }),
  SUBSCRIPTION_EXPIRING: (x) => ({
    en: { title: x.days === 1 ? 'Subscription ends tomorrow' : `Subscription ends in ${x.days} days`, body: `Renew before ${x.p.periodEnd ? isoDateLabel(x.p.periodEnd, 'en') : 'the end date'} to keep receiving bookings.` },
    ur: { title: x.days === 1 ? 'سبسکرپشن کل ختم ہو رہی ہے' : `سبسکرپشن ${x.days} دن میں ختم ہو رہی ہے`, body: `بکنگز جاری رکھنے کے لیے ${x.p.periodEnd ? isoDateLabel(x.p.periodEnd, 'ur') : 'آخری تاریخ'} سے پہلے تجدید کریں۔` },
  }),
  SUBSCRIPTION_EXPIRED: (x) => ({
    en: {
      title: 'Subscription expired',
      body: x.p.graceEnd ? `Your subscription ended. You can still renew until ${isoDateLabel(x.p.graceEnd, 'en')} (grace period).` : 'Your subscription ended. Renew now to appear in search and receive bookings.',
    },
    ur: {
      title: 'سبسکرپشن ختم ہو گئی',
      body: x.p.graceEnd ? `آپ کی سبسکرپشن ختم ہو گئی ہے۔ آپ ${isoDateLabel(x.p.graceEnd, 'ur')} تک (رعایتی مدت) تجدید کر سکتے ہیں۔` : 'آپ کی سبسکرپشن ختم ہو گئی ہے۔ سرچ میں نظر آنے اور بکنگز لینے کے لیے ابھی تجدید کریں۔',
    },
  }),
  STAFF_JOINED: (x) => ({
    en: { title: 'Staff member joined', body: `${x.staff} accepted the invitation and can now sign in.` },
    ur: { title: 'اسٹاف ممبر شامل ہو گیا', body: `${x.staff} نے دعوت قبول کر لی ہے اور اب سائن اِن کر سکتا ہے۔` },
  }),
  STAFF_SCHEDULE_UPDATED: () => ({
    en: { title: 'Your schedule was updated', body: 'Your working hours, breaks or leave changed. Open the app to review them.' },
    ur: { title: 'آپ کا شیڈول تبدیل ہو گیا', body: 'آپ کے کام کے اوقات، وقفوں یا چھٹی میں تبدیلی ہوئی ہے۔ ایپ کھول کر دیکھ لیں۔' },
  }),
};

export function renderNotification(type: NotificationType, lang: Language, params: TemplateParams): Rendered {
  const text = TEMPLATES[type](n(params))[lang];
  return { title: clean(text.title, 120), body: clean(text.body, 300) };
}
