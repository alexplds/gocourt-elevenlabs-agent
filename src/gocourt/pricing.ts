import { toMinutes, weekdayOf } from "../time.js";
import type { PricingRule, ScheduleCourt } from "./types.js";

/**
 * Hourly rate for one court at the start of a slot.
 *
 * Rules are ordered by priority ascending
 * (a lower number wins; the basic rule is 9999), a blank court, court type,
 * or sport means any, and the window is `start <= slot start < end`.
 * A court's own positive `price_per_hour` is used as-is. Otherwise the rate
 * is the matching rule's `price_per_hour * price_multiplier`, or the basic
 * rule when nothing else covers the slot.
 */
export function hourlyRate(
  court: Pick<ScheduleCourt, "id" | "courtType" | "pricePerHour" | "sportId">,
  rules: PricingRule[],
  date: string,
  startTime: string,
  timeZone: string,
): number | null {
  const own = positive(court.pricePerHour);
  if (own != null) return own;

  const active = rules.filter((rule) => rule.isActive !== false);
  const basic = active.find((rule) => rule.isBasic);
  const weekday = weekdayOf(date, timeZone);
  const start = toMinutes(startTime);
  const matching = active
    .filter((rule) => ruleMatchesCourt(rule, court) && ruleMatchesDay(rule, weekday) && ruleMatchesTime(rule, start))
    .sort((a, b) => a.priority - b.priority || a.id - b.id);
  const chosen = matching[0];
  const fromRule = chosen ? rateFromRule(chosen, basic) : null;
  if (fromRule != null) return fromRule;
  return basic ? rateFromRule(basic, basic) : null;
}

/** Slot price in euros, or null when no positive rate is known. */
export function quoteEuros(
  court: Pick<ScheduleCourt, "id" | "courtType" | "pricePerHour" | "sportId">,
  rules: PricingRule[],
  date: string,
  startTime: string,
  durationMinutes: number,
  timeZone: string,
): number | null {
  const hourly = hourlyRate(court, rules, date, startTime, timeZone);
  if (hourly == null || durationMinutes <= 0) return null;
  return roundMoney(hourly * (durationMinutes / 60));
}

function rateFromRule(rule: PricingRule, basic: PricingRule | undefined): number | null {
  const multiplier = Number.isFinite(rule.priceMultiplier) ? rule.priceMultiplier : 1;
  const own = positive(rule.pricePerHour);
  if (own != null) return roundMoney(own * multiplier);
  const base = positive(basic?.pricePerHour);
  if (base != null) return roundMoney(base * multiplier);
  return null;
}

function ruleMatchesCourt(
  rule: PricingRule,
  court: Pick<ScheduleCourt, "id" | "courtType" | "sportId">,
): boolean {
  if (rule.courtId != null) return rule.courtId === court.id;
  if (rule.courtType) return rule.courtType === court.courtType;
  if (rule.sportId != null) return rule.sportId === court.sportId;
  return true;
}

function ruleMatchesDay(rule: PricingRule, weekday: number): boolean {
  if (rule.daysOfWeek) {
    const allowed = rule.daysOfWeek
      .split(",")
      .map((part) => Number(part.trim()))
      .filter((day) => Number.isInteger(day));
    return allowed.includes(weekday);
  }
  const weekend = weekday === 0 || weekday === 6;
  const dayType = (rule.dayType ?? "all").toLowerCase();
  if (dayType === "all" || dayType === "") return true;
  if (dayType === "weekend") return weekend;
  if (dayType === "weekday") return !weekend;
  return false;
}

function ruleMatchesTime(rule: PricingRule, startMinutes: number): boolean {
  return startMinutes >= toMinutes(rule.startTime) && startMinutes < toMinutes(rule.endTime);
}

function positive(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

function roundMoney(amount: number): number {
  return Math.round(amount * 100) / 100;
}
