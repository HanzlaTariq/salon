export type SalonStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';

export interface SalonRow {
  id: string;
  name: string;
  salonType: 'MEN' | 'LADIES' | 'UNISEX';
  city: string;
  area: string;
  addressLine: string;
  phone: string;
  status: SalonStatus;
  submittedAt: string | null;
  createdAt: string;
  ownerName: string;
  ownerEmail: string;
}

export interface SalonList {
  items: SalonRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface SalonStats {
  pending: number;
  approved: number;
  rejected: number;
  suspended: number;
}

export interface SalonFileMeta {
  id: string;
  kind: 'DOCUMENT' | 'PHOTO';
  docType: string;
  contentType: string;
  sizeBytes: number;
  originalName: string | null;
  createdAt: string;
}

export interface SalonDetail {
  salon: Omit<SalonRow, 'ownerName' | 'ownerEmail'> & {
    contactEmail: string | null;
    description: string | null;
    latitude: number | null;
    longitude: number | null;
    approvedAt: string | null;
    rejectionReason: string | null;
    suspendedReason: string | null;
  };
  owner: { id: string; fullName: string; email: string; phone: string | null } | null;
  files: SalonFileMeta[];
  applications: Array<{
    id: string;
    submissionNo: number;
    status: 'SUBMITTED' | 'APPROVED' | 'REJECTED';
    submittedAt: string;
    reviewedAt: string | null;
    decisionReason: string | null;
  }>;
  canViewDocuments: boolean;
}

export const TYPE_LABEL: Record<SalonRow['salonType'], string> = { MEN: "Men's", LADIES: 'Ladies', UNISEX: 'Unisex' };

export const DOC_LABEL: Record<string, string> = {
  CNIC_FRONT: 'CNIC (front)',
  CNIC_BACK: 'CNIC (back)',
  BUSINESS_LICENSE: 'Business licence',
  OTHER_DOCUMENT: 'Other document',
  COVER: 'Cover photo',
  GALLERY: 'Gallery photo',
};

export const badgeOf = (s: SalonStatus) => s.toLowerCase() as 'pending' | 'approved' | 'rejected' | 'suspended';
