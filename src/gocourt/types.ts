export type ClubSummary = {
  id: number;
  name: string;
};

export type OperatingHours = {
  isClosed: boolean;
  openTime: string;
  closeTime: string;
  reason?: string;
};

export type BookingRules = {
  minDurationHours: number;
  maxDurationHours: number | null;
  incrementHours: number;
  ownerStepMinutes: number | null;
  advanceBookingDays: number;
};

export type ScheduleBooking = {
  id: number;
  startTime: string;
  endTime: string;
  status: string;
};

export type ScheduleCourt = {
  id: number;
  name: string;
  courtNumber: number | null;
  courtType: string | null;
  coverage: string | null;
  sportName: string | null;
  /** Null when the court row has no price. The club rule supplies it. */
  pricePerHour: number | null;
  sportId?: number | null;
  bookings: ScheduleBooking[];
};

/**
 * One row of GET /clubs/:clubId/pricing-rules.
 * A null court, court type, or sport means the rule applies to any of them.
 * Lower `priority` wins. The basic rule is the fallback (priority 9999).
 */
export type PricingRule = {
  id: number;
  name: string;
  isBasic: boolean;
  isActive: boolean;
  dayType: string | null;
  /** Comma-separated JS weekdays, Sunday = 0. Null means use dayType. */
  daysOfWeek: string | null;
  startTime: string;
  endTime: string;
  pricePerHour: number | null;
  priceMultiplier: number;
  priority: number;
  courtId: number | null;
  courtType: string | null;
  sportId: number | null;
};

export type BookingRecord = {
  id: number;
  courtId: number;
  courtName: string;
  date: string;
  startTime: string;
  endTime: string;
  status: string;
  customerName: string;
  customerPhone: string;
  priceEuros: number | null;
};

export type BookingSearch = {
  q?: string;
  from?: string;
  to?: string;
  limit?: number;
};

export type ManualBookingInput = {
  courtId: number;
  date: string;
  startTime: string;
  endTime: string;
  customerName: string;
  customerPhone: string;
};

export type ManualBookingResult = {
  booking: BookingRecord;
};

export interface GoCourtClient {
  getMyClubs(): Promise<ClubSummary[]>;
  getOperatingHours(clubId: number, date: string): Promise<OperatingHours>;
  getBookingRules(clubId: number): Promise<BookingRules>;
  getSchedule(clubId: number, date: string): Promise<ScheduleCourt[]>;
  /** Active club pricing rules. Cached briefly by the HTTP client. */
  getPricingRules(clubId: number): Promise<PricingRule[]>;
  listBookings(clubId: number, query: BookingSearch): Promise<BookingRecord[]>;
  createManualBooking(clubId: number, input: ManualBookingInput): Promise<ManualBookingResult>;
  cancelBooking(clubId: number, bookingId: number): Promise<BookingRecord>;
}

export class GoCourtApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "GoCourtApiError";
    this.status = status;
    this.code = code;
  }
}
