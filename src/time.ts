/** Wall-clock helpers. GoCourt stores booking dates and times in Europe/Athens. */

const WEEKDAYS: Array<{ index: number; names: string[] }> = [
  { index: 0, names: ["sunday", "sun", "κυριακη"] },
  { index: 1, names: ["monday", "mon", "δευτερα"] },
  { index: 2, names: ["tuesday", "tue", "τριτη"] },
  { index: 3, names: ["wednesday", "wed", "τεταρτη"] },
  { index: 4, names: ["thursday", "thu", "πεμπτη"] },
  { index: 5, names: ["friday", "fri", "παρασκευη"] },
  { index: 6, names: ["saturday", "sat", "σαββατο"] },
];

const PERIOD_WORDS: Array<{ period: TimeOfDay; words: string[] }> = [
  { period: "morning", words: ["morning", "πρωι"] },
  { period: "afternoon", words: ["afternoon", "μεσημερι", "απογευμα"] },
  { period: "evening", words: ["evening", "βραδυ", "tonight", "αποψε"] },
  { period: "night", words: ["night", "νυχτα"] },
];

export type TimeOfDay = "morning" | "afternoon" | "evening" | "night";

export type Clarify = { needsClarification: true; say: string };

export function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
}

export function athensParts(instant: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
} {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(fmt.formatToParts(instant).map((part) => [part.type, part.value]));
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: weekdayMap[parts.weekday ?? ""] ?? 0,
  };
}

export function isoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function todayIso(now: Date, timeZone: string): string {
  const parts = athensParts(now, timeZone);
  return isoDate(parts.year, parts.month, parts.day);
}

export function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  const utc = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1));
  utc.setUTCDate(utc.getUTCDate() + days);
  return isoDate(utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate());
}

export function weekdayOf(iso: string, timeZone: string): number {
  // Noon UTC keeps the calendar date stable across offsets.
  return athensParts(new Date(`${iso}T12:00:00Z`), timeZone).weekday;
}

export function minutesNow(now: Date, timeZone: string): number {
  const parts = athensParts(now, timeZone);
  return parts.hour * 60 + parts.minute;
}

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function fromMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Normalise a GoCourt time (`19:00` or `19:00:00`) to HH:MM. */
export function normalizeTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return fromMinutes(hour * 60 + minute);
}

/**
 * A JSON date from GoCourt is either `YYYY-MM-DD` or a timestamp.
 * Date-only strings are calendar dates. Timestamps are read in the court timezone
 * so a UTC midnight serialization cannot shift the day.
 */
export function calendarDate(value: unknown, timeZone: string): string {
  if (value instanceof Date) return todayIso(value, timeZone);
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return trimmed.slice(0, 10);
  return todayIso(parsed, timeZone);
}

function stripPeriod(text: string): { rest: string; period: TimeOfDay | null } {
  const folded = fold(text);
  for (const entry of PERIOD_WORDS) {
    for (const word of entry.words) {
      if (folded === word || folded.endsWith(` ${word}`)) {
        const rest = folded.slice(0, folded.length - word.length).trim();
        return { rest, period: entry.period };
      }
    }
  }
  return { rest: folded, period: null };
}

export function parseDateInput(
  raw: unknown,
  now: Date,
  timeZone: string,
): { date?: string; period?: TimeOfDay; clarify?: Clarify } {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return { clarify: { needsClarification: true, say: "Which day would you like? Today, tomorrow, or another day?" } };
  }
  const { rest, period } = stripPeriod(String(raw));
  const today = todayIso(now, timeZone);

  if (/^\d{4}-\d{2}-\d{2}$/.test(rest)) {
    return { date: rest, period: period ?? undefined };
  }
  if (rest === "today" || rest === "σημερα") return { date: today, period: period ?? undefined };
  if (rest === "tomorrow" || rest === "αυριο") return { date: addDays(today, 1), period: period ?? undefined };
  if (rest === "day after tomorrow" || rest === "μεθαυριο") {
    return { date: addDays(today, 2), period: period ?? undefined };
  }

  const weekday = WEEKDAYS.find((item) => item.names.includes(rest));
  if (weekday) {
    const todayIndex = athensParts(now, timeZone).weekday;
    const delta = (weekday.index - todayIndex + 7) % 7;
    return { date: addDays(today, delta), period: period ?? undefined };
  }

  return {
    clarify: {
      needsClarification: true,
      say: "I didn't catch the day. Do you want today, tomorrow, or a specific date?",
    },
  };
}

function asTimeOfDay(value: unknown): TimeOfDay | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const folded = fold(value);
  return PERIOD_WORDS.find((entry) => entry.words.includes(folded) || entry.period === folded)?.period ?? null;
}

/**
 * Turn a spoken time into HH:MM.
 * A bare hour from 1 to 11, or a period with no clock time, asks for clarification
 * instead of guessing morning versus evening.
 */
export function parseTimeInput(raw: unknown, timeOfDayRaw: unknown, hintedPeriod?: TimeOfDay): { time?: string; clarify?: Clarify } {
  const period = asTimeOfDay(timeOfDayRaw) ?? hintedPeriod ?? null;
  const text = typeof raw === "string" ? raw.trim() : raw === undefined || raw === null ? "" : String(raw).trim();

  if (!text) {
    if (period) {
      return {
        clarify: {
          needsClarification: true,
          say: `Which hour in the ${period}? For example, seven, or half past seven.`,
        },
      };
    }
    return { clarify: { needsClarification: true, say: "What time would you like to start?" } };
  }

  const meridiem = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|πμ|μμ|μ\.μ\.|π\.μ\.)$/i);
  if (meridiem) {
    let hour = Number(meridiem[1]);
    const minute = Number(meridiem[2] ?? "0");
    const marker = fold(meridiem[3] ?? "");
    const isPm = marker.startsWith("p") || marker.startsWith("μ");
    if (hour < 1 || hour > 12 || minute > 59) {
      return { clarify: { needsClarification: true, say: "I didn't catch that time. Could you say the hour again?" } };
    }
    if (isPm && hour < 12) hour += 12;
    if (!isPm && hour === 12) hour = 0;
    return { time: fromMinutes(hour * 60 + minute) };
  }

  const clock = text.match(/^(\d{1,2})[:.h](\d{2})(?::(\d{2}))?$/i);
  if (clock) {
    const hour = Number(clock[1]);
    const minute = Number(clock[2]);
    if (hour > 23 || minute > 59) {
      return { clarify: { needsClarification: true, say: "I didn't catch that time. Could you say the hour again?" } };
    }
    // Minutes make this a clock time. A bare "7" is still ambiguous (handled below).
    // time_of_day can still move a morning hour to the evening, e.g. 7:00 + evening.
    if (hour <= 11 && period) return applyPeriod(hour, minute, period);
    return { time: fromMinutes(hour * 60 + minute) };
  }

  if (/^\d{1,2}$/.test(text)) {
    const hour = Number(text);
    if (hour > 23) {
      return { clarify: { needsClarification: true, say: "I didn't catch that time. Could you say the hour again?" } };
    }
    if (hour <= 11) {
      if (!period) {
        const label = hour === 0 ? "midnight or noon" : `${hour} in the morning or ${hour} in the evening`;
        return { clarify: { needsClarification: true, say: `Did you mean ${label}?` } };
      }
      return applyPeriod(hour, 0, period);
    }
    return { time: fromMinutes(hour * 60) };
  }

  return { clarify: { needsClarification: true, say: "I didn't catch that time. Could you say the hour again?" } };
}

function applyPeriod(hour: number, minute: number, period: TimeOfDay): { time?: string; clarify?: Clarify } {
  if (hour >= 12) return { time: fromMinutes(hour * 60 + minute) };
  if (period === "morning") {
    return { time: fromMinutes((hour === 12 ? 0 : hour) * 60 + minute) };
  }
  if (hour === 0) return { time: fromMinutes(minute) };
  return { time: fromMinutes((hour + 12) * 60 + minute) };
}

export function speakTime(hhmm: string): string {
  const minutes = toMinutes(hhmm);
  const hour24 = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const period = hour24 < 12 ? "in the morning" : hour24 < 17 ? "in the afternoon" : hour24 < 21 ? "in the evening" : "at night";
  const clock = minute === 0 ? `${hour12}` : minute === 30 ? `half past ${hour12}` : `${hour12}:${String(minute).padStart(2, "0")}`;
  return `${clock} ${period}`;
}

export function speakDate(iso: string, now: Date, timeZone: string): string {
  const today = todayIso(now, timeZone);
  if (iso === today) return "today";
  if (iso === addDays(today, 1)) return "tomorrow";
  const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" }).format(new Date(`${iso}T12:00:00Z`));
  const day = Number(iso.slice(8, 10));
  const month = new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC" }).format(new Date(`${iso}T12:00:00Z`));
  return `${weekday} ${day} ${month}`;
}

export function speakDuration(minutes: number): string {
  if (minutes === 60) return "one hour";
  if (minutes === 90) return "an hour and a half";
  if (minutes === 120) return "two hours";
  if (minutes === 30) return "30 minutes";
  if (minutes % 60 === 0) return `${minutes / 60} hours`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} minutes`;
  return `${hours} hour${hours === 1 ? "" : "s"} and ${rest} minutes`;
}

export function speakMoney(amount: number): string {
  if (!Number.isFinite(amount)) return "";
  const rounded = Math.round(amount * 100) / 100;
  if (Number.isInteger(rounded)) return `${rounded} euro${rounded === 1 ? "" : "s"}`;
  return `${rounded.toFixed(2)} euros`;
}

/** Greek national digits, or the digits as typed. Mirrors GoCourt's phone key. */
export function phoneKey(value: string): string {
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("30") && digits.length === 12) digits = digits.slice(2);
  return digits;
}

export function isValidPhone(value: string): boolean {
  return /^[0-9+\-\s()]{7,20}$/.test(value.trim());
}
