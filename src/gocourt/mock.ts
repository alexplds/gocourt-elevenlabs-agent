import { addDays, phoneKey, todayIso, toMinutes } from "../time.js";
import type {
  BookingRecord,
  BookingRules,
  BookingSearch,
  ClubSummary,
  GoCourtClient,
  ManualBookingInput,
  ManualBookingResult,
  PricingRule,
  ScheduleCourt,
} from "./types.js";
import { GoCourtApiError } from "./types.js";

type StoredBooking = BookingRecord & { clubId: number };

type MockOptions = {
  /** Clock used to place the sample bookings on "tomorrow". */
  now?: Date;
  timeZone?: string;
  extraClub?: boolean;
  closedDates?: string[];
  /** When set, every court uses this hourly price. Null reproduces a club whose courts have no price of their own. */
  courtPricePerHour?: number | null;
  /** Active pricing rules. Empty unless a test supplies them. */
  pricingRules?: PricingRule[];
  /** Forces the total_price on a created booking, including 0. */
  bookingPriceEuros?: number | null;
};

const RULES: BookingRules = {
  minDurationHours: 1,
  maxDurationHours: 2,
  incrementHours: 0.5,
  ownerStepMinutes: null,
  advanceBookingDays: 14,
};

/**
 * In-memory GoCourt. Same operations as the HTTP client, with two courts and
 * a few bookings so the voice tools can be demoed without credentials.
 */
export function createMockClient(options: MockOptions = {}): GoCourtClient & { snapshot(): StoredBooking[] } {
  const timeZone = options.timeZone ?? "Europe/Athens";
  const now = options.now ?? new Date();
  const tomorrow = addDays(todayIso(now, timeZone), 1);
  const dayAfter = addDays(tomorrow, 1);
  const closed = new Set(options.closedDates ?? []);

  const clubs: ClubSummary[] = [{ id: 1, name: "Demo Padel Club" }];
  if (options.extraClub) clubs.push({ id: 2, name: "Second Demo Club" });

  let nextId = 2000;
  const bookings: StoredBooking[] = [
    booking(1001, 1, 1, "Court 1", tomorrow, "19:00", "20:00", "Maria Papadopoulou", "694 111 2233", 20),
    booking(1002, 1, 2, "Court 2", tomorrow, "19:00", "20:30", "Guest", "694 000 0001", 36),
    booking(1003, 1, 1, "Court 1", tomorrow, "10:00", "11:00", "Nikos Alexiou", "694 555 1212", 20),
    booking(1004, 1, 2, "Court 2", dayAfter, "11:00", "12:00", "Nikos Alexiou", "694 555 1212", 24),
  ];

  const courtPrice = options.courtPricePerHour;
  const courts = [
    { id: 1, name: "Court 1", courtNumber: 1, courtType: "Doubles", coverage: "Outdoor", sportName: "Padel", sportId: 1, pricePerHour: courtPrice === undefined ? 20 : courtPrice },
    { id: 2, name: "Court 2", courtNumber: 2, courtType: "Doubles", coverage: "Indoor", sportName: "Padel", sportId: 1, pricePerHour: courtPrice === undefined ? 24 : courtPrice },
  ];
  const pricingRules = (options.pricingRules ?? []).map((rule) => ({ ...rule }));

  function schedule(clubId: number, date: string): ScheduleCourt[] {
    if (clubId !== 1) return [];
    return courts.map((court) => ({
      ...court,
      bookings: bookings
        .filter((item) => item.clubId === clubId && item.courtId === court.id && item.date === date)
        .map((item) => ({ id: item.id, startTime: item.startTime, endTime: item.endTime, status: item.status })),
    }));
  }

  return {
    snapshot: () => bookings.map((item) => ({ ...item })),
    async getMyClubs() {
      return clubs.map((club) => ({ ...club }));
    },
    async getOperatingHours(_clubId, date) {
      if (closed.has(date)) {
        return { isClosed: true, openTime: "08:00", closeTime: "23:00", reason: "Club is closed on this date" };
      }
      return { isClosed: false, openTime: "08:00", closeTime: "23:00" };
    },
    async getBookingRules() {
      return { ...RULES };
    },
    async getSchedule(clubId, date) {
      return schedule(clubId, date);
    },
    async getPricingRules() {
      return pricingRules.map((rule) => ({ ...rule }));
    },
    async listBookings(clubId, query) {
      return filterBookings(bookings.filter((item) => item.clubId === clubId), query);
    },
    async createManualBooking(clubId, input) {
      const court = courts.find((item) => item.id === input.courtId);
      if (!court || clubId !== 1) throw new GoCourtApiError("Court not found", 404);
      const hours = closed.has(input.date)
        ? { isClosed: true, openTime: "08:00", closeTime: "23:00" }
        : { isClosed: false, openTime: "08:00", closeTime: "23:00" };
      if (hours.isClosed) throw new GoCourtApiError("The club is closed on this date", 400);
      if (input.startTime < hours.openTime || input.endTime > hours.closeTime) {
        throw new GoCourtApiError(`This club operates between ${hours.openTime} and ${hours.closeTime}`, 400);
      }
      const clash = bookings.some(
        (item) =>
          item.courtId === input.courtId &&
          item.date === input.date &&
          item.status === "confirmed" &&
          toMinutes(input.startTime) < toMinutes(item.endTime) &&
          toMinutes(input.endTime) > toMinutes(item.startTime),
      );
      if (clash) {
        throw new GoCourtApiError("Time slot not available", 400, "SLOT_CONFLICT");
      }
      const hoursLen = (toMinutes(input.endTime) - toMinutes(input.startTime)) / 60;
      const hourly = court.pricePerHour ?? 0;
      const computed = Math.round(hourly * hoursLen * 100) / 100;
      const created = booking(
        nextId++,
        clubId,
        court.id,
        court.name,
        input.date,
        input.startTime,
        input.endTime,
        input.customerName,
        input.customerPhone,
        options.bookingPriceEuros !== undefined ? options.bookingPriceEuros : computed,
      );
      bookings.push(created);
      return { booking: { ...created } };
    },
    async cancelBooking(clubId, bookingId) {
      const found = bookings.find((item) => item.clubId === clubId && item.id === bookingId);
      if (!found) throw new GoCourtApiError("Booking not found for this club", 404);
      found.status = "cancelled";
      return { ...found };
    },
  };
}

function booking(
  id: number,
  clubId: number,
  courtId: number,
  courtName: string,
  date: string,
  startTime: string,
  endTime: string,
  customerName: string,
  customerPhone: string,
  priceEuros: number | null,
): StoredBooking {
  return {
    id,
    clubId,
    courtId,
    courtName,
    date,
    startTime,
    endTime,
    status: "confirmed",
    customerName,
    customerPhone,
    priceEuros,
  };
}

function filterBookings(rows: StoredBooking[], query: BookingSearch): BookingRecord[] {
  const q = (query.q ?? "").trim().toLowerCase();
  const digits = q.replace(/\D/g, "");
  return rows
    .filter((item) => {
      if (query.from && item.date < query.from) return false;
      if (query.to && item.date > query.to) return false;
      if (!q) return true;
      const name = item.customerName.toLowerCase();
      const phone = phoneKey(item.customerPhone);
      return name.includes(q) || (digits.length > 0 && phone.includes(digits));
    })
    .slice(0, query.limit ?? 50)
    .map(({ clubId: _clubId, ...rest }) => rest);
}