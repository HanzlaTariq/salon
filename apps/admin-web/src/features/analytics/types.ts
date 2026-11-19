/** API shapes for Phase 13 platform analytics. Money is a decimal STRING; counts are numbers. Salon money never appears here. */
export interface Rates { resolved: number; completionRate: number | null; cancellationRate: number | null; noShowRate: number | null }
export interface RangeView { from: string; to: string; days: number }

export interface Overview {
  currency: string;
  range: RangeView;
  salons: { total: number; byStatus: Record<'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED', number>; applicationsSubmittedInRange: number; approvedInRange: number; rejectedInRange: number };
  staff: { active: number; billable: number };
  customers: { registered: number; active: number; newInRange: number };
  owners: { registered: number; newInRange: number };
  subscriptions: { active: number; inGrace: number; expired: number; suspended: number; neverSubscribed: number };
  platformRevenue: { monthlyRecurringRevenue: string; annualRunRate: string; verifiedThisMonth: string; verifiedThisYear: string; pendingPayments: number; pendingAmount: string };
  bookings: { total: number; completed: number; cancelled: number; noShow: number; open: number; walkIn: number; online: number; rates: Rates; walkInSharePct: number | null };
}

export interface GrowthPoint { month: string; newSalons: number; approvedSalons: number; newCustomers: number; newOwners: number; appointments: number; completed: number }
export interface RevenuePoint { month: string; verified: string; payments: number }
export interface Trend { months: number; growth: GrowthPoint[]; subscriptionRevenue: RevenuePoint[] }

export interface CityRow {
  city: string; approvedSalons: number; suspendedSalons: number; activeStaff: number; subscribedSalons: number;
  appointments: number; completed: number; cancelled: number; noShow: number; rates: Rates;
}
export interface Cities { range: RangeView; items: CityRow[] }

export const RANGE_PRESETS = [
  { key: '7', label: 'Last 7 days', days: 7 },
  { key: '30', label: 'Last 30 days', days: 30 },
  { key: '90', label: 'Last 90 days', days: 90 },
  { key: '365', label: 'Last 12 months', days: 365 },
] as const;
export type PresetKey = (typeof RANGE_PRESETS)[number]['key'];
