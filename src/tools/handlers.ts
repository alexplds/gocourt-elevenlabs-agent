import { quoteEuros } from "../gocourt/pricing.js";
import type { GoCourtClient } from "../gocourt/types.js";
import { GoCourtApiError } from "../gocourt/types.js";
import {
  addDays,
  fold,
  fromMinutes,
  isValidPhone,
  minutesNow,
  parseDateInput,
  parseTimeInput,
  phoneKey,
  speakDate,
  speakDuration,
  speakMoney,
  speakTime,
  todayIso,
  toMinutes,
  type TimeOfDay,
} from "../time.js";
import type { BookingRecord, BookingRules, PricingRule, ScheduleCourt } from "../gocourt/types.js";

export type ToolContext = {
  now: Date;
  timeZone: string;
  clubId: number | null;
};

export type ToolBody = Record<string, unknown>;

type CourtOffer = {
  id: number;
  name: string;
  coverage: string | null;
  priceEuros: number | null;
};

type Offer = {
  date: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  courts: CourtOffer[];
};

const spoken = {
  clarify(say: string, extra: ToolBody = {}): ToolBody {
    return { ok: true, needs_clarification: true, say, ...extra };
  },
  fail(say: string, error?: string): ToolBody {
    return { ok: false, say, error: error ?? say };
  },
};

export async function checkAvailability(client: GoCourtClient, input: ToolBody, ctx: ToolContext): Promise<ToolBody> {
  try {
    const resolved = await resolveClub(client, ctx.clubId);
    if (!resolved.ok) return resolved.body;
    const club = resolved.club;
    const when = resolveWhen(input, ctx);
    if ("say" in when && when.needs_clarification) return when;
    const slot = when as ResolvedWhen;
    const day = await loadDay(client, club.id, slot.date, ctx.timeZone);
    const problem = describeSlotProblem(day, slot, ctx);
    if (problem) return { ok: true, ...problem, club: { id: club.id, name: club.name } };
    return availabilityAnswer(club, day, slot, input, ctx);
  } catch (error) {
    return failure(error);
  }
}

export async function createBooking(client: GoCourtClient, input: ToolBody, ctx: ToolContext): Promise<ToolBody> {
  try {
    const resolved = await resolveClub(client, ctx.clubId);
    if (!resolved.ok) return resolved.body;
    const club = resolved.club;
    const when = resolveWhen(input, ctx);
    if ("say" in when && when.needs_clarification) return when;
    const slot = when as ResolvedWhen;
    const name = typeof input.customer_name === "string" ? input.customer_name.trim() : "";
    const phone = typeof input.customer_phone === "string" ? input.customer_phone.trim() : "";
    if (name.length < 2 || name.length > 100) {
      return spoken.clarify("What name should I put on the booking?");
    }
    if (!isValidPhone(phone)) {
      return spoken.clarify("What phone number should I put on the booking?");
    }
    const day = await loadDay(client, club.id, slot.date, ctx.timeZone);
    const problem = describeSlotProblem(day, slot, ctx);
    if (problem) return { ok: true, ...problem, club: { id: club.id, name: club.name } };
    const offer = buildOffer(day, slot);
    const chosen = chooseCourt(day.courts, offer, input);
    if (chosen.clarify) return spoken.clarify(chosen.clarify);
    if (!chosen.court) {
      return { ok: true, ...takenPayload(day, slot, offer, chosen.taken, ctx, spokenCourt(input)), club: { id: club.id, name: club.name } };
    }
    const courtLabel = chosen.taken ? undefined : spokenCourt(input);
    if (!isConfirmed(input.confirmed)) {
      const price = priceFor(day, chosen.court, slot);
      return {
        ok: true,
        needs_confirmation: true,
        available: true,
        club: { id: club.id, name: club.name },
        date: slot.date,
        start_time: slot.startTime,
        end_time: slot.endTime,
        duration_minutes: slot.durationMinutes,
        court: { id: chosen.court.id, name: chosen.court.name },
        customer_name: name,
        customer_phone: phone,
        price_euros: price,
        say: `I can book ${slotPhrase(slot, ctx, courtLabel)} for ${name}. Shall I book it?`,
      };
    }
    const created = await client.createManualBooking(club.id, {
      courtId: chosen.court.id,
      date: slot.date,
      startTime: slot.startTime,
      endTime: slot.endTime,
      customerName: name,
      customerPhone: phone,
    });
    const booking = { ...created.booking, courtName: chosen.court.name, courtId: chosen.court.id };
    const price = knownPrice(booking.priceEuros) ?? priceFor(day, chosen.court, slot);
    return {
      ok: true,
      booked: true,
      booking: publicBooking(booking, price),
      say: `Booked. ${slotPhrase(slot, ctx, courtLabel)} for ${booking.customerName}. The booking number is ${booking.id}.`,
    };
  } catch (error) {
    if (error instanceof GoCourtApiError && (error.status === 400 || error.status === 409)) {
      return { ok: true, available: false, say: `That time is no longer free. ${error.message}` };
    }
    return failure(error);
  }
}

export async function findBooking(client: GoCourtClient, input: ToolBody, ctx: ToolContext): Promise<ToolBody> {
  try {
    const resolved = await resolveClub(client, ctx.clubId);
    if (!resolved.ok) return resolved.body;
    const club = resolved.club;
    const found = await searchBookings(client, club.id, input, ctx);
    if ("say" in found && found.needs_clarification) return found;
    const matches = await withDisplayCourtNames(client, club.id, found as BookingRecord[]);
    if (matches.length === 0) {
      return { ok: true, matches: [], say: "I couldn't find a booking with those details. Could you give me the name, phone, or booking number?" };
    }
    return {
      ok: true,
      matches: matches.slice(0, 5).map((item) => publicBooking(item, item.priceEuros)),
      say: describeMatches(matches, ctx),
    };
  } catch (error) {
    return failure(error);
  }
}

export async function cancelBooking(client: GoCourtClient, input: ToolBody, ctx: ToolContext): Promise<ToolBody> {
  try {
    const resolved = await resolveClub(client, ctx.clubId);
    if (!resolved.ok) return resolved.body;
    const club = resolved.club;
    const found = await searchBookings(client, club.id, input, ctx);
    if ("say" in found && found.needs_clarification) return found;
    const matches = await withDisplayCourtNames(
      client,
      club.id,
      (found as BookingRecord[]).filter((item) => item.status === "confirmed"),
    );
    if (matches.length === 0) {
      return { ok: true, cancelled: false, say: "I couldn't find a booking to cancel with those details." };
    }
    if (matches.length > 1) {
      return {
        ok: true,
        needs_clarification: true,
        matches: matches.slice(0, 5).map((item) => publicBooking(item, item.priceEuros)),
        say: `I found more than one booking. ${describeMatches(matches, ctx)} Which booking number should I cancel?`,
      };
    }
    const match = matches[0]!;
    if (!isConfirmed(input.confirmed)) {
      return {
        ok: true,
        needs_confirmation: true,
        booking: publicBooking(match, match.priceEuros),
        say: `I found booking ${match.id} for ${match.customerName}, ${speakDate(match.date, ctx.now, ctx.timeZone)} from ${speakTime(match.startTime)} to ${speakTime(match.endTime)}. Shall I cancel it?`,
      };
    }
    const cancelled = await client.cancelBooking(club.id, match.id);
    const named = { ...cancelled, courtName: match.courtName };
    return {
      ok: true,
      cancelled: true,
      booking: publicBooking(named, named.priceEuros),
      say: `Cancelled booking ${match.id} for ${match.customerName}, ${speakDate(match.date, ctx.now, ctx.timeZone)} at ${speakTime(match.startTime)}.`,
    };
  } catch (error) {
    return failure(error);
  }
}

type ResolvedWhen = {
  date: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  courtQuery: string;
};

type DayContext = {
  date: string;
  timeZone: string;
  hours: { isClosed: boolean; openTime: string; closeTime: string; reason?: string };
  rules: BookingRules;
  courts: ScheduleCourt[];
  pricingRules: PricingRule[];
  stepMinutes: number;
};

async function resolveClub(client: GoCourtClient, configuredId: number | null): Promise<
  { ok: true; club: { id: number; name: string } } | { ok: false; body: ToolBody }
> {
  const clubs = await client.getMyClubs();
  if (configuredId) {
    const match = clubs.find((club) => club.id === configuredId);
    if (!match) return { ok: false, body: spoken.fail("That club is not available on this account.") };
    return { ok: true, club: match };
  }
  if (clubs.length === 1) return { ok: true, club: clubs[0]! };
  if (clubs.length === 0) return { ok: false, body: spoken.fail("This account has no club to book for.") };
  const names = clubs.map((club) => `${club.name} (id ${club.id})`).join(", ");
  return {
    ok: false,
    body: spoken.clarify(`Which club? ${names}.`, { clubs: clubs.map((club) => ({ id: club.id, name: club.name })) }),
  };
}

function resolveWhen(input: ToolBody, ctx: ToolContext): ResolvedWhen | ToolBody {
  const parsedDate = parseDateInput(input.date, ctx.now, ctx.timeZone);
  if (parsedDate.clarify) return spoken.clarify(parsedDate.clarify.say);
  const period = (typeof input.time_of_day === "string" ? input.time_of_day : undefined) as TimeOfDay | undefined;
  const parsedTime = parseTimeInput(input.time, period ?? parsedDate.period, parsedDate.period);
  if (parsedTime.clarify) return spoken.clarify(parsedTime.clarify.say);
  const startTime = parsedTime.time!;
  const durationMinutes = resolveDuration(input.duration_minutes);
  if (typeof durationMinutes !== "number") return durationMinutes;
  const start = toMinutes(startTime);
  return {
    date: parsedDate.date!,
    startTime,
    endTime: fromMinutes(start + durationMinutes),
    durationMinutes,
    courtQuery: typeof input.court === "string" ? input.court.trim() : "",
  };
}

function resolveDuration(raw: unknown): number | ToolBody {
  if (raw === undefined || raw === null || raw === "") return 60;
  const minutes = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(minutes) || minutes < 30 || minutes > 8 * 60) {
    return spoken.clarify("How long should the booking be? The usual length is one hour.");
  }
  return minutes;
}

async function loadDay(client: GoCourtClient, clubId: number, date: string, timeZone: string): Promise<DayContext> {
  const [hours, rules, courts, pricingRules] = await Promise.all([
    client.getOperatingHours(clubId, date),
    client.getBookingRules(clubId),
    client.getSchedule(clubId, date),
    client.getPricingRules(clubId),
  ]);
  const grid = Math.round(rules.incrementHours * 60) || 30;
  const stepMinutes = rules.ownerStepMinutes && rules.ownerStepMinutes > 0 ? Math.min(grid, rules.ownerStepMinutes) : grid;
  return { date, timeZone, hours, rules, courts, pricingRules, stepMinutes };
}

function describeSlotProblem(day: DayContext, slot: ResolvedWhen, ctx: ToolContext): ToolBody | null {
  if (day.hours.isClosed) {
    return {
      available: false,
      say: day.hours.reason ? `The club is closed that day. ${day.hours.reason}.` : "The club is closed that day.",
    };
  }
  const minMinutes = Math.round(day.rules.minDurationHours * 60);
  const maxMinutes = day.rules.maxDurationHours == null ? 8 * 60 : Math.round(day.rules.maxDurationHours * 60);
  if (slot.durationMinutes < minMinutes || slot.durationMinutes > maxMinutes || slot.durationMinutes % day.stepMinutes !== 0) {
    return spoken.clarify(
      `Bookings are in steps of ${speakDuration(day.stepMinutes)}, from ${speakDuration(minMinutes)} up to ${speakDuration(maxMinutes)}. How long would you like?`,
    );
  }
  const open = toMinutes(day.hours.openTime);
  const close = toMinutes(day.hours.closeTime);
  const start = toMinutes(slot.startTime);
  const end = toMinutes(slot.endTime);
  if ((start - open) % day.stepMinutes !== 0) {
    const earlier = start - ((start - open) % day.stepMinutes);
    const later = earlier + day.stepMinutes;
    const options = [earlier, later].filter((minute) => minute >= open && minute + slot.durationMinutes <= close);
    const spokenOptions = options.map((minute) => speakTime(fromMinutes(minute))).join(" or ");
    return spoken.clarify(
      spokenOptions
        ? `We start on the ${day.stepMinutes === 60 ? "hour" : `${day.stepMinutes} minute`} marks. Did you mean ${spokenOptions}?`
        : "That start time isn't on the booking grid.",
    );
  }
  if (start < open || end > close) {
    return {
      available: false,
      say: `That day the club is open from ${speakTime(day.hours.openTime)} until ${speakTime(day.hours.closeTime)}.`,
    };
  }
  const today = todayIso(ctx.now, ctx.timeZone);
  if (slot.date < today || (slot.date === today && start <= minutesNow(ctx.now, ctx.timeZone))) {
    return { available: false, say: "That time has already passed. Would you like a later time?" };
  }
  return null;
}

function buildOffer(day: DayContext, slot: ResolvedWhen): Offer {
  const start = toMinutes(slot.startTime);
  const end = toMinutes(slot.endTime);
  const courts = day.courts
    .filter((court) => isCourtFree(court, start, end))
    .map((court) => ({
      id: court.id,
      name: court.name,
      coverage: court.coverage,
      priceEuros: priceFor(day, court, slot),
    }));
  return { date: slot.date, startTime: slot.startTime, endTime: slot.endTime, durationMinutes: slot.durationMinutes, courts };
}

function isCourtFree(court: ScheduleCourt, start: number, end: number): boolean {
  return court.bookings.every((booking) => {
    if (booking.status && booking.status !== "confirmed") return true;
    const bookingStart = toMinutes(booking.startTime);
    const bookingEnd = toMinutes(booking.endTime);
    return !(start < bookingEnd && end > bookingStart);
  });
}

function nearestOffers(day: DayContext, slot: ResolvedWhen, ctx: ToolContext): Offer[] {
  const open = toMinutes(day.hours.openTime);
  const close = toMinutes(day.hours.closeTime);
  const requested = toMinutes(slot.startTime);
  const today = todayIso(ctx.now, ctx.timeZone);
  const nowMinutes = minutesNow(ctx.now, ctx.timeZone);
  const found: Array<{ distance: number; offer: Offer }> = [];
  for (let start = open; start + slot.durationMinutes <= close; start += day.stepMinutes) {
    if (start === requested) continue;
    if (slot.date < today || (slot.date === today && start <= nowMinutes)) continue;
    const courts = day.courts
      .filter((court) => isCourtFree(court, start, start + slot.durationMinutes))
      .map((court) => ({
        id: court.id,
        name: court.name,
        coverage: court.coverage,
        priceEuros: priceFor(day, court, { startTime: fromMinutes(start), durationMinutes: slot.durationMinutes }),
      }));
    if (courts.length === 0) continue;
    found.push({
      distance: Math.abs(start - requested),
      offer: {
        date: slot.date,
        startTime: fromMinutes(start),
        endTime: fromMinutes(start + slot.durationMinutes),
        durationMinutes: slot.durationMinutes,
        courts,
      },
    });
  }
  found.sort((a, b) => a.distance - b.distance || a.offer.startTime.localeCompare(b.offer.startTime));
  return found.slice(0, 3).map((item) => item.offer);
}

function availabilityAnswer(
  club: { id: number; name: string },
  day: DayContext,
  slot: ResolvedWhen,
  input: ToolBody,
  ctx: ToolContext,
): ToolBody {
  const offer = buildOffer(day, slot);
  const chosen = chooseCourt(day.courts, offer, input);
  if (chosen.clarify) return spoken.clarify(chosen.clarify);
  if (!chosen.court) {
    return { ok: true, club: { id: club.id, name: club.name }, ...takenPayload(day, slot, offer, chosen.taken, ctx, spokenCourt(input)) };
  }
  if (chosen.taken) {
    return substitutedPayload(club, slot, offer, ctx, spokenCourt(input) ?? chosen.taken.name, priceFor(day, chosen.court, slot));
  }
  return availablePayload(club, slot, offer, ctx, spokenCourt(input), priceFor(day, chosen.court, slot));
}

/** Words the caller used for a court. Empty when they did not ask for one. */
function spokenCourt(input: ToolBody): string | undefined {
  if (typeof input.court !== "string") return undefined;
  const query = input.court.trim();
  if (!query || ["any", "either", "no preference"].includes(fold(query))) return undefined;
  return query;
}

function takenPayload(
  day: DayContext,
  slot: ResolvedWhen,
  offer: Offer,
  taken: ScheduleCourt | undefined,
  ctx: ToolContext,
  requestedCourt?: string,
): ToolBody {
  const suggestions = nearestOffers(day, slot, ctx);
  const sameTime = taken ? offer.courts : [];
  const label = requestedCourt ?? taken?.name ?? "That court";
  const sameTimeSay = sameTime.length ? `${label} is taken then, but that time is still free. ` : "";
  return {
    available: false,
    date: slot.date,
    start_time: slot.startTime,
    end_time: slot.endTime,
    duration_minutes: slot.durationMinutes,
    same_time_alternatives: sameTime,
    suggestions: suggestions.map(publicSuggestion),
    say: `${sameTimeSay}${takenSay(slot, suggestions, ctx, !sameTimeSay)}`.trim(),
  };
}

function chooseCourt(
  courts: ScheduleCourt[],
  offer: Offer,
  input: ToolBody,
): { court?: ScheduleCourt; clarify?: string; taken?: ScheduleCourt } {
  const wantedId = input.court_id === undefined || input.court_id === null || input.court_id === "" ? null : Number(input.court_id);
  const query = typeof input.court === "string" ? fold(input.court) : "";
  const freeIds = new Set(offer.courts.map((court) => court.id));
  if (wantedId !== null && Number.isInteger(wantedId)) {
    const court = courts.find((item) => item.id === wantedId);
    if (!court) return { clarify: "I couldn't find that court." };
    if (!freeIds.has(court.id)) return substituteCourt(courts, freeIds, court);
    return { court };
  }
  if (query && query !== "any" && query !== "either" && query !== "no preference") {
    const matches = courts.filter((court) => courtMatches(court, query));
    if (matches.length === 0) return { clarify: "Which court did you mean?" };
    const free = matches.filter((court) => freeIds.has(court.id));
    const exact = free.find((court) => fold(court.name) === query);
    if (exact) return { court: exact };
    if (free[0]) return { court: free[0] };
    return substituteCourt(courts, freeIds, matches[0]!);
  }
  const first = offer.courts[0];
  if (!first) return { court: undefined };
  return { court: courts.find((court) => court.id === first.id) };
}

function substituteCourt(
  courts: ScheduleCourt[],
  freeIds: Set<number>,
  requested: ScheduleCourt,
): { court?: ScheduleCourt; taken: ScheduleCourt } {
  const fallback = courts.find((court) => freeIds.has(court.id));
  if (!fallback) return { taken: requested };
  return { court: fallback, taken: requested };
}

function courtMatches(court: ScheduleCourt, query: string): boolean {
  const name = fold(court.name);
  const coverage = fold(court.coverage ?? "");
  const type = fold(court.courtType ?? "");
  const number = court.courtNumber ? String(court.courtNumber) : "";
  return (
    name.includes(query) ||
    coverage.includes(query) ||
    type.includes(query) ||
    query === number ||
    query === `court ${number}` ||
    query === name
  );
}

function priceFor(
  day: DayContext,
  court: ScheduleCourt,
  slot: { startTime: string; durationMinutes: number },
): number | null {
  return quoteEuros(court, day.pricingRules, day.date, slot.startTime, slot.durationMinutes, day.timeZone);
}

/** A returned total of 0 is GoCourt's empty price, not a free court. */
function knownPrice(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

function priceClause(price: number | null): string {
  return price == null ? "" : `, about ${speakMoney(price)}`;
}

function substitutedPayload(
  club: { id: number; name: string },
  slot: ResolvedWhen,
  offer: Offer,
  ctx: ToolContext,
  requestedCourt: string,
  priceEuros: number | null,
): ToolBody {
  return {
    ok: true,
    available: true,
    needs_confirmation: true,
    club: { id: club.id, name: club.name },
    date: slot.date,
    start_time: slot.startTime,
    end_time: slot.endTime,
    duration_minutes: slot.durationMinutes,
    courts: offer.courts,
    price_euros: priceEuros,
    say: `${requestedCourt} is taken then, but that time is still free ${slotPhrase(slot, ctx)}${priceClause(priceEuros)}. Shall I book it?`,
  };
}

function availablePayload(
  club: { id: number; name: string },
  slot: ResolvedWhen,
  offer: Offer,
  ctx: ToolContext,
  requestedCourt: string | undefined,
  priceEuros: number | null,
): ToolBody {
  const lead = requestedCourt ? `${requestedCourt} is free ${slotPhrase(slot, ctx)}` : `That's free ${slotPhrase(slot, ctx)}`;
  return {
    ok: true,
    available: true,
    needs_confirmation: true,
    club: { id: club.id, name: club.name },
    date: slot.date,
    start_time: slot.startTime,
    end_time: slot.endTime,
    duration_minutes: slot.durationMinutes,
    courts: offer.courts,
    price_euros: priceEuros,
    say: `${lead}${priceClause(priceEuros)}. Shall I book it?`,
  };
}

function slotPhrase(slot: ResolvedWhen, ctx: ToolContext, courtName?: string): string {
  const when = `${speakDate(slot.date, ctx.now, ctx.timeZone)} from ${speakTime(slot.startTime)} to ${speakTime(slot.endTime)}`;
  return courtName ? `${courtName} ${when}` : when;
}

function takenSay(slot: ResolvedWhen, suggestions: Offer[], ctx: ToolContext, lead = true): string {
  if (suggestions.length === 0) {
    return lead ? "That time is taken, and I don't see another free slot that day." : "";
  }
  const alternatives = suggestions.map((offer) => speakTime(offer.startTime)).join(", ");
  const prefix = lead ? "That time is taken. " : "Other nearby times: ";
  return `${prefix}The nearest free times ${speakDate(slot.date, ctx.now, ctx.timeZone)} are ${alternatives}.`;
}

function publicSuggestion(offer: Offer): ToolBody {
  const court = offer.courts[0];
  return {
    date: offer.date,
    start_time: offer.startTime,
    end_time: offer.endTime,
    court_id: court?.id,
    court_name: court?.name,
    price_euros: court?.priceEuros,
  };
}

function publicBooking(booking: BookingRecord, price: number | null): ToolBody {
  return {
    id: booking.id,
    court_id: booking.courtId,
    court_name: booking.courtName,
    date: booking.date,
    start_time: booking.startTime,
    end_time: booking.endTime,
    status: booking.status,
    customer_name: booking.customerName,
    customer_phone: booking.customerPhone,
    price_euros: price,
  };
}

/**
 * The cancel API returns the booking row, whose court_id is the database id.
 * The schedule has the name a caller would recognise (`Court 1`, not `Court 17`).
 * That name stays on the booking JSON so it can be answered if they ask.
 * Speech includes it only when two bookings share a day and a time.
 */
async function withDisplayCourtNames(
  client: GoCourtClient,
  clubId: number,
  bookings: BookingRecord[],
): Promise<BookingRecord[]> {
  const courtsByDate = new Map<string, ScheduleCourt[] | null>();
  const named: BookingRecord[] = [];
  for (const booking of bookings) {
    if (!courtsByDate.has(booking.date)) {
      try {
        courtsByDate.set(booking.date, await client.getSchedule(clubId, booking.date));
      } catch {
        courtsByDate.set(booking.date, null);
      }
    }
    const court = courtsByDate.get(booking.date)?.find((item) => item.id === booking.courtId);
    const displayName = court?.name.trim();
    named.push(displayName ? { ...booking, courtName: displayName } : booking);
  }
  return named;
}

async function searchBookings(
  client: GoCourtClient,
  clubId: number,
  input: ToolBody,
  ctx: ToolContext,
): Promise<BookingRecord[] | ToolBody> {
  const bookingId = parseBookingId(input.booking_id ?? input.booking_ref);
  const name = typeof input.customer_name === "string" ? input.customer_name.trim() : "";
  const phone = typeof input.customer_phone === "string" ? input.customer_phone.trim() : "";
  const dateRaw = input.date;
  let date: string | undefined;
  if (dateRaw !== undefined && dateRaw !== null && String(dateRaw).trim() !== "") {
    const parsed = parseDateInput(dateRaw, ctx.now, ctx.timeZone);
    if (parsed.clarify) return spoken.clarify(parsed.clarify.say);
    date = parsed.date;
  }
  if (!bookingId && name.length < 2 && phoneKey(phone).length < 6) {
    return spoken.clarify("To find the booking I need a booking number, or the name and phone on it.");
  }
  const today = todayIso(ctx.now, ctx.timeZone);
  const query = bookingId
    ? { from: addDays(today, -30), to: addDays(today, 60), limit: 200 }
    : {
        q: phone || name,
        from: date ? undefined : name || phone ? undefined : today,
        to: date ? undefined : name || phone ? undefined : addDays(today, 60),
        limit: 50,
      };
  const rows = await client.listBookings(clubId, query);
  const upcomingOnly = !date && !bookingId;
  return rows.filter((row) => {
    if (bookingId && row.id !== bookingId) return false;
    if (date && row.date !== date) return false;
    if (name && !nameMatches(row.customerName, name)) return false;
    if (phone && phoneKey(row.customerPhone) !== phoneKey(phone)) return false;
    if (row.status !== "confirmed") return false;
    if (upcomingOnly && !isUpcoming(row, ctx)) return false;
    return true;
  });
}

function nameMatches(haystack: string, needle: string): boolean {
  const hay = fold(haystack);
  const parts = fold(needle).split(/\s+/).filter(Boolean);
  return parts.length > 0 && parts.every((part) => hay.includes(part));
}

function isUpcoming(booking: BookingRecord, ctx: ToolContext): boolean {
  const today = todayIso(ctx.now, ctx.timeZone);
  if (booking.date > today) return true;
  if (booking.date < today) return false;
  return toMinutes(booking.endTime) > minutesNow(ctx.now, ctx.timeZone);
}

function parseBookingId(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value !== "string") return null;
  const digits = value.replace(/\D/g, "");
  if (!digits) return null;
  const id = Number(digits);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function describeMatches(matches: BookingRecord[], ctx: ToolContext): string {
  const shown = matches.slice(0, 3);
  const sameSlot = new Set<string>();
  const counts = new Map<string, number>();
  for (const item of shown) {
    const key = `${item.date}|${item.startTime}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [key, count] of counts) {
    if (count > 1) sameSlot.add(key);
  }
  const bits = shown.map((item) => {
    const when = `${speakDate(item.date, ctx.now, ctx.timeZone)} at ${speakTime(item.startTime)}`;
    const court = sameSlot.has(`${item.date}|${item.startTime}`) ? `, ${item.courtName}` : "";
    return `booking ${item.id}, ${item.customerName}, ${when}${court}`;
  });
  const extra = matches.length > shown.length ? ` and ${matches.length - shown.length} more` : "";
  return `${bits.join("; ")}${extra}.`;
}

function isConfirmed(value: unknown): boolean {
  return value === true || value === "true" || value === "yes";
}

function failure(error: unknown): ToolBody {
  if (error instanceof GoCourtApiError) {
    if (error.status === 401) return spoken.fail("I couldn't sign in to the club account.", error.message);
    if (error.status === 504) {
      return spoken.fail("The booking system is taking too long to answer. Please try again in a moment.", error.message);
    }
    if (error.code === "MUST_CHANGE_PASSWORD" || /password change required/i.test(error.message)) {
      return spoken.fail("The club account has to change its password in GoCourt before I can book.", error.message);
    }
    return spoken.fail("The booking system didn't accept that. Please try again in a moment.", error.message);
  }
  return spoken.fail("Something went wrong while checking the courts. Please try again in a moment.");
}
