import assert from "node:assert/strict";
import test from "node:test";
import { addDays, parseDateInput, parseTimeInput, todayIso } from "../src/time.js";

const NOW = new Date("2026-10-12T09:00:00+03:00");
const TZ = "Europe/Athens";

test("today and tomorrow follow Europe/Athens", () => {
  assert.equal(todayIso(NOW, TZ), "2026-10-12");
  assert.equal(parseDateInput("tomorrow", NOW, TZ).date, "2026-10-13");
  assert.equal(parseDateInput("αύριο", NOW, TZ).date, "2026-10-13");
  assert.equal(parseDateInput("Friday", NOW, TZ).date, "2026-10-16");
});

test("tomorrow evening keeps the day and asks for an hour", () => {
  const parsed = parseDateInput("tomorrow evening", NOW, TZ);
  assert.equal(parsed.date, "2026-10-13");
  assert.equal(parsed.period, "evening");
  const time = parseTimeInput(undefined, undefined, parsed.period);
  assert.equal(time.clarify?.needsClarification, true);
});

test("a bare hour asks morning or evening; evening resolves to 19:00", () => {
  const ambiguous = parseTimeInput("7", undefined);
  assert.match(ambiguous.clarify?.say ?? "", /morning or/);
  assert.equal(parseTimeInput("7", "evening").time, "19:00");
  assert.equal(parseTimeInput("7pm", undefined).time, "19:00");
  assert.equal(parseTimeInput("19:00:00", undefined).time, "19:00");
});

test("addDays stays on the calendar", () => {
  assert.equal(addDays("2026-10-12", 1), "2026-10-13");
});
