import { SalonFileRecord, SalonRecord } from './salon.types';

/** Owner-facing view: never exposes storage keys or other users' data. */
export const ownerSalonView = (s: SalonRecord) => ({
  id: s.id, name: s.name, salonType: s.salonType, city: s.city, area: s.area, addressLine: s.addressLine, phone: s.phone,
  contactEmail: s.contactEmail, description: s.description, latitude: s.latitude, longitude: s.longitude, status: s.status,
  submittedAt: s.submittedAt, approvedAt: s.approvedAt,
  rejectionReason: s.status === 'REJECTED' ? s.rejectionReason : null,
  suspendedReason: s.status === 'SUSPENDED' ? s.suspendedReason : null,
  createdAt: s.createdAt, updatedAt: s.updatedAt,
});

export const fileView = (f: SalonFileRecord) => ({
  id: f.id, kind: f.kind, docType: f.docType, contentType: f.contentType, sizeBytes: f.sizeBytes,
  originalName: f.originalName, createdAt: f.createdAt,
});

/** Safe original-name for display only (never used in storage keys or paths). */
export function displayName(name: string | undefined): string | null {
  if (!name) return null;
  const cleaned = name.replace(/[\u0000-\u001f<>"'`\\/:*?|]/g, '').trim().slice(0, 120);
  return cleaned.length > 0 ? cleaned : null;
}
