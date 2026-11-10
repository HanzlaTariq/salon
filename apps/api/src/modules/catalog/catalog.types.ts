/**
 * Phase 4 domain types and PURE rules (no I/O) for categories, services, staff-based pricing and
 * staff-service assignments. Pricing rules live here so they can be unit-tested without a database;
 * the database enforces the same invariants again (CHECK constraints + composite foreign keys).
 */
export const PRICING_MODES = ['FIXED', 'STAFF_BASED'] as const;
export type PricingMode = (typeof PRICING_MODES)[number];

/** Technical abuse caps (the product has no business limit: "unlimited" categories and services). */
export const CATALOG_LIMITS = { categories: 100, services: 1000, staff: 100, staffPerService: 100 } as const;

export const MIN_DURATION_MIN = 5;
export const MAX_DURATION_MIN = 480;
export const MAX_PRICE = 1_000_000;

export interface CategoryRecord {
  id: string;
  salonId: string;
  name: string;
  description: string | null;
  imageFileId: string | null;
  displayOrder: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ServiceRecord {
  id: string;
  salonId: string;
  categoryId: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  pricingMode: PricingMode;
  /** "300.00" for FIXED services, null for STAFF_BASED. Money is NUMERIC in the database, never a float. */
  basePrice: string | null;
  imageFileId: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface StaffRecord {
  id: string;
  salonId: string;
  userId: string | null;
  displayName: string;
  isOwner: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface AssignmentRecord {
  serviceId: string;
  staffId: string;
  /** "500.00" for STAFF_BASED services, null for FIXED. */
  price: string | null;
}

/** Validates a money amount (0 .. MAX_PRICE, at most 2 decimals) and returns it as "300.00"; null when invalid. */
export function toMoney(n: unknown): string | null {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > MAX_PRICE) return null;
  const cents = Math.round(n * 100);
  if (Math.abs(n * 100 - cents) > 1e-6) return null;
  return (cents / 100).toFixed(2);
}

/** Normalises a NUMERIC value coming back from PostgreSQL (string, number or Prisma Decimal) to "300.00". */
export function moneyText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return Number(v).toFixed(2);
}

export interface PricingInput {
  mode: PricingMode;
  price?: number | null;
}

export interface AssignmentInput {
  staffId: string;
  price?: number | null;
}

export interface PlannedAssignment {
  staffId: string;
  price: string | null;
}

export type PricingPlan =
  | { ok: false; message: string }
  | {
      ok: true;
      mode: PricingMode;
      basePrice: string | null;
      assignments: PlannedAssignment[];
      modeChanged: boolean;
      /** True when the stored assignment rows must be rewritten (delete + insert in one transaction). */
      rewriteAssignments: boolean;
    };

const fail = (message: string): PricingPlan => ({ ok: false, message });

/**
 * Decides the next pricing state of a service. Used for create (current = FIXED with no price, no assignments)
 * and for update.
 *  - FIXED: a salon-wide price is required; assignments carry NO price.
 *  - STAFF_BASED: no salon-wide price; every assignment carries its own price.
 *  - Changing the mode never silently drops prices: switching to STAFF_BASED with existing assignments needs the
 *    new staff list (with prices); switching to FIXED clears the staff prices (assignments stay).
 */
export function planPricing(
  current: { mode: PricingMode; basePrice: string | null },
  existing: ReadonlyArray<AssignmentRecord>,
  input: { pricing?: PricingInput; staff?: ReadonlyArray<AssignmentInput> },
): PricingPlan {
  const mode = input.pricing?.mode ?? current.mode;
  const modeChanged = mode !== current.mode;

  let basePrice: string | null;
  if (mode === 'STAFF_BASED') {
    if (input.pricing?.price !== undefined && input.pricing.price !== null) return fail('A staff-based service has no salon-wide price. Set a price per staff member instead.');
    basePrice = null;
  } else if (input.pricing?.price !== undefined && input.pricing.price !== null) {
    basePrice = toMoney(input.pricing.price);
    if (basePrice === null) return fail(`The price must be between 0 and ${MAX_PRICE} with at most two decimals.`);
  } else if (!modeChanged && current.basePrice !== null) {
    basePrice = current.basePrice;
  } else {
    return fail('A price is required for a fixed-price service.');
  }

  if (input.staff) {
    if (input.staff.length > CATALOG_LIMITS.staffPerService) return fail(`A service can have at most ${CATALOG_LIMITS.staffPerService} staff members.`);
    const seen = new Set<string>();
    const assignments: PlannedAssignment[] = [];
    for (const a of input.staff) {
      if (seen.has(a.staffId)) return fail('A staff member can be assigned to a service only once.');
      seen.add(a.staffId);
      const has = a.price !== undefined && a.price !== null;
      if (mode === 'FIXED') {
        if (has) return fail('Staff prices are only used when the service is staff-based.');
        assignments.push({ staffId: a.staffId, price: null });
      } else {
        if (!has) return fail('Every assigned staff member needs a price for a staff-based service.');
        const p = toMoney(a.price);
        if (p === null) return fail(`Staff prices must be between 0 and ${MAX_PRICE} with at most two decimals.`);
        assignments.push({ staffId: a.staffId, price: p });
      }
    }
    return { ok: true, mode, basePrice, assignments, modeChanged, rewriteAssignments: true };
  }

  if (!modeChanged) {
    return { ok: true, mode, basePrice, assignments: existing.map((e) => ({ staffId: e.staffId, price: e.price })), modeChanged, rewriteAssignments: false };
  }
  if (mode === 'FIXED') {
    return { ok: true, mode, basePrice, assignments: existing.map((e) => ({ staffId: e.staffId, price: null })), modeChanged, rewriteAssignments: true };
  }
  if (existing.length > 0) return fail('Provide the staff list with a price for each staff member when switching to staff-based pricing.');
  return { ok: true, mode, basePrice, assignments: [], modeChanged, rewriteAssignments: false };
}

/** Lowest / highest price a customer can pay for a service, from the salon-wide price or the assigned staff. */
export function priceRange(mode: PricingMode, basePrice: string | null, staffPrices: ReadonlyArray<string | null>): { from: string; to: string } | null {
  const values = mode === 'FIXED' ? (basePrice === null ? [] : [basePrice]) : staffPrices.filter((p): p is string => p !== null);
  if (values.length === 0) return null;
  const nums = values.map(Number);
  return { from: Math.min(...nums).toFixed(2), to: Math.max(...nums).toFixed(2) };
}

/** Reorder requests must list EVERY existing id exactly once (no partial or duplicated orderings). */
export function isCompleteOrdering(requested: ReadonlyArray<string>, existing: ReadonlyArray<string>): boolean {
  if (requested.length !== existing.length || new Set(requested).size !== requested.length) return false;
  const have = new Set(existing);
  return requested.every((id) => have.has(id));
}
