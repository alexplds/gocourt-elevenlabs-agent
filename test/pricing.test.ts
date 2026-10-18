import assert from "node:assert/strict";
import test from "node:test";
import { quoteEuros } from "../src/gocourt/pricing.js";
import type { PricingRule, ScheduleCourt } from "../src/gocourt/types.js";

const zone = "Europe/Athens";

function court(pricePerHour: number | null, id = 11): Pick<ScheduleCourt, "id" | "courtType" | "pricePerHour" | "sportId"> {
  return { id, courtType: "Doubles", pricePerHour, sportId: 3 };
}

function rule(overrides: Partial<PricingRule> = {}): PricingRule {
  return {
    id: 1,
    name: "Basic Price",
    isBasic: true,
    isActive: true,
    dayType: "all",
    daysOfWeek: null,
    startTime: "00:00",
    endTime: "23:59",
    pricePerHour: 40,
    priceMultiplier: 1,
    priority: 9999,
    courtId: null,
    courtType: null,
    sportId: null,
    ...overrides,
  };
}

test("Sunday 18 Oct 2026 at 19:00 for an hour is the basic 40 euro rate", () => {
  const basic = rule();
  assert.equal(quoteEuros(court(null), [basic], "2026-10-18", "19:00", 60, zone), 40);
  assert.equal(quoteEuros(court(null), [basic], "2026-10-18", "19:00", 120, zone), 80);
});

test("a court's own price wins, and a lower priority rule beats the basic fallback", () => {
  const basic = rule();
  const peak = rule({
    id: 2,
    name: "Evening",
    isBasic: false,
    pricePerHour: 55,
    priceMultiplier: 1,
    priority: 1,
    startTime: "17:00",
    endTime: "22:00",
  });
  assert.equal(quoteEuros(court(20), [peak, basic], "2026-10-18", "19:00", 60, zone), 20);
  assert.equal(quoteEuros(court(null), [peak, basic], "2026-10-18", "19:00", 60, zone), 55);
  assert.equal(quoteEuros(court(null), [peak, basic], "2026-10-18", "12:00", 60, zone), 40);
});

test("a multiplier rule uses the basic hourly price, and a court filter does not leak", () => {
  const basic = rule({ pricePerHour: 40 });
  const weekend = rule({
    id: 4,
    name: "Weekend",
    isBasic: false,
    pricePerHour: null,
    priceMultiplier: 1.5,
    priority: 2,
    dayType: "weekend",
  });
  const otherCourt = rule({
    id: 5,
    name: "Court 9 only",
    isBasic: false,
    pricePerHour: 99,
    priority: 0,
    courtId: 9,
  });
  assert.equal(quoteEuros(court(null), [weekend, otherCourt, basic], "2026-10-18", "19:00", 60, zone), 60);
  assert.equal(quoteEuros(court(null), [weekend, otherCourt, basic], "2026-10-19", "19:00", 60, zone), 40);
  assert.equal(quoteEuros(court(null), [], "2026-10-18", "19:00", 60, zone), null);
  assert.equal(quoteEuros(court(0), [rule({ isActive: false })], "2026-10-18", "19:00", 60, zone), null);
});
