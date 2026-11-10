export const SALON_TYPES = ['MEN', 'LADIES', 'UNISEX'] as const;
export type SalonType = (typeof SALON_TYPES)[number];

export const SALON_STATUSES = ['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED'] as const;
export type SalonStatus = (typeof SALON_STATUSES)[number];

export const FILE_KINDS = ['DOCUMENT', 'PHOTO'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export const DOCUMENT_TYPES = ['CNIC_FRONT', 'CNIC_BACK', 'BUSINESS_LICENSE', 'OTHER_DOCUMENT'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export const PHOTO_TYPES = ['COVER', 'GALLERY'] as const;
export type PhotoType = (typeof PHOTO_TYPES)[number];
/** Phase 4: category/service pictures. Stored as PHOTO files but never counted as salon photos. */
export const CATALOG_IMAGE_TYPE = 'CATALOG' as const;
export type FileDocType = DocumentType | PhotoType | typeof CATALOG_IMAGE_TYPE;

/** Technical caps for repeatable slots (single-slot types hold exactly one file; uploading again replaces it). */
export const MULTI_SLOT_LIMITS: Partial<Record<FileDocType, number>> = { GALLERY: 12, OTHER_DOCUMENT: 5 };
export const isMultiSlot = (t: FileDocType): boolean => t in MULTI_SLOT_LIMITS;

/** Only these statuses allow the owner to change the application: DOCUMENTS and submission (review evidence). */
export const OWNER_EDITABLE: readonly SalonStatus[] = ['DRAFT', 'REJECTED'];

/**
 * Phase 4: a live salon keeps working. The owner may edit the profile, opening hours, salon PHOTOS and the
 * catalogue while DRAFT, REJECTED or APPROVED. PENDING (under review) and SUSPENDED stay locked.
 * The same rule is enforced by the salons_guard / salon_files_guard triggers.
 */
export const PROFILE_EDITABLE: readonly SalonStatus[] = ['DRAFT', 'REJECTED', 'APPROVED'];

export interface SalonRecord {
  id: string;
  ownerUserId: string;
  name: string;
  salonType: SalonType;
  city: string;
  area: string;
  addressLine: string;
  phone: string;
  contactEmail: string | null;
  description: string | null;
  latitude: number | null;
  longitude: number | null;
  status: SalonStatus;
  submittedAt: Date | null;
  approvedAt: Date | null;
  approvedBy: string | null;
  rejectionReason: string | null;
  suspendedReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SalonFileRecord {
  id: string;
  salonId: string;
  kind: FileKind;
  docType: FileDocType;
  storageKey: string;
  contentType: string;
  sizeBytes: number;
  originalName: string | null;
  uploadedBy: string;
  createdAt: Date;
}

export interface ApplicationRecord {
  id: string;
  salonId: string;
  submissionNo: number;
  status: 'SUBMITTED' | 'APPROVED' | 'REJECTED';
  submittedAt: Date;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  decisionReason: string | null;
}

export interface Requirements {
  requiredDocuments: DocumentType[];
  minPhotos: number;
}

export interface MissingItems {
  documents: DocumentType[];
  photos: number;
}

/** What the owner still has to upload before the application can be submitted. */
export function computeMissing(req: Requirements, files: Pick<SalonFileRecord, 'kind' | 'docType'>[]): MissingItems {
  const have = new Set(files.filter((f) => f.kind === 'DOCUMENT').map((f) => f.docType));
  const photos = files.filter((f) => f.kind === 'PHOTO' && f.docType !== CATALOG_IMAGE_TYPE).length;
  return {
    documents: req.requiredDocuments.filter((d) => !have.has(d)),
    photos: Math.max(0, req.minPhotos - photos),
  };
}

export const isComplete = (m: MissingItems): boolean => m.documents.length === 0 && m.photos === 0;

export const DEFAULT_REQUIREMENTS: Requirements = { requiredDocuments: ['CNIC_FRONT', 'CNIC_BACK'], minPhotos: 1 };

/**
 * Reads the Super-Admin-configurable requirement (platform_settings key `salon_application`) defensively:
 * anything malformed falls back to the safe default instead of breaking registration.
 */
export function parseRequirements(raw: unknown): Requirements {
  if (!raw || typeof raw !== 'object') return DEFAULT_REQUIREMENTS;
  const v = raw as { requiredDocuments?: unknown; minPhotos?: unknown };
  const docs = Array.isArray(v.requiredDocuments)
    ? [...new Set(v.requiredDocuments.filter((d): d is DocumentType => (DOCUMENT_TYPES as readonly string[]).includes(d as string)))]
    : DEFAULT_REQUIREMENTS.requiredDocuments;
  const min = typeof v.minPhotos === 'number' && Number.isInteger(v.minPhotos) && v.minPhotos >= 0 && v.minPhotos <= 12 ? v.minPhotos : DEFAULT_REQUIREMENTS.minPhotos;
  return { requiredDocuments: docs, minPhotos: min };
}
