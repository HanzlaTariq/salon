import { ReviewRecord } from './reviews.repository';
import { REVIEW_LIMITS, editWindow } from './reviews.types';

const services = (r: ReviewRecord) => r.services.map((s) => ({ serviceId: s.serviceId, name: s.name, rating: s.rating }));
const response = (r: ReviewRecord) => (r.ownerResponse ? { text: r.ownerResponse, at: r.ownerResponseAt } : null);

/** What the whole world sees on a salon page. No ids of customers, no appointment ids, no moderation data. */
export const publicView = (r: ReviewRecord) => ({
  id: r.id,
  authorName: r.authorName,
  rating: r.salonRating,
  staffRating: r.staffRating,
  staffName: r.staffRating !== null ? r.staffName : null,
  comment: r.comment,
  services: services(r),
  response: response(r),
  createdAt: r.createdAt.toISOString(),
  edited: r.editedAt !== null,
});

/** What an author sees of their own review (also when it is hidden, with the reason). */
export function customerView(r: ReviewRecord, nowMs: number) {
  const win = editWindow(r.createdAt, new Date(nowMs));
  return {
    id: r.id,
    appointmentId: r.appointmentId,
    salon: { id: r.salonId, name: r.salonName },
    staff: { id: r.staffId, name: r.staffName },
    visitAt: r.visitAt,
    rating: r.salonRating,
    staffRating: r.staffRating,
    comment: r.comment,
    services: services(r),
    status: r.status,
    hiddenReason: r.status === 'HIDDEN' ? r.hiddenReason : null,
    response: response(r),
    createdAt: r.createdAt.toISOString(),
    edited: r.editedAt !== null,
    canEdit: r.status === 'PUBLISHED' && win.open,
    editableUntil: r.status === 'PUBLISHED' ? win.closesAt.toISOString() : null,
    editWindowDays: REVIEW_LIMITS.editWindowDays,
  };
}

/** What the salon owner sees: the review, the visit, the response and the report state. Never the customer's id, e-mail or phone. */
export const ownerView = (r: ReviewRecord) => ({
  id: r.id,
  appointmentId: r.appointmentId,
  authorName: r.authorName,
  visitAt: r.visitAt,
  staff: { id: r.staffId, name: r.staffName },
  rating: r.salonRating,
  staffRating: r.staffRating,
  comment: r.comment,
  services: services(r),
  response: response(r),
  reported: r.openReport !== null,
  createdAt: r.createdAt.toISOString(),
  edited: r.editedAt !== null,
});

/** What a staff member sees about reviews of THEIR OWN work. No appointment id, no owner response of other topics, no reports. */
export const staffView = (r: ReviewRecord) => ({
  id: r.id,
  authorName: r.authorName,
  visitAt: r.visitAt,
  staffRating: r.staffRating,
  salonRating: r.salonRating,
  comment: r.comment,
  services: services(r),
  createdAt: r.createdAt.toISOString(),
});

/** Moderation view: everything needed to decide, including the open report and who hid it. */
export const adminView = (r: ReviewRecord) => ({
  id: r.id,
  salon: { id: r.salonId, name: r.salonName },
  staff: { id: r.staffId, name: r.staffName },
  customerUserId: r.customerUserId,
  authorName: r.authorName,
  visitAt: r.visitAt,
  rating: r.salonRating,
  staffRating: r.staffRating,
  comment: r.comment,
  services: services(r),
  status: r.status,
  hiddenReason: r.hiddenReason,
  hiddenAt: r.hiddenAt,
  response: response(r),
  openReport: r.openReport,
  createdAt: r.createdAt.toISOString(),
  edited: r.editedAt !== null,
});
