import assert from "node:assert/strict";
import test from "node:test";
import {
  buildScanRange,
  classifySweep,
  filterSchedule,
  getBogotaParts,
  isAlreadyBookedResponse,
  isSuccessfulBookingResponse,
  levelsMatch,
  sortSchedules,
} from "../../supabase/functions/auto-book/domain.js";

const config = {
  headquarterId: 2,
  classTypeId: 1,
  minStartMinutes: 540,
  maxStartMinutes: 720,
  allowedDays: [1, 2, 3, 4, 5],
  targetLevel: "B1",
  minimumLeadTimeHours: 4,
  blockedSlots: [],
};

function schedule(overrides = {}) {
  return {
    id: 101,
    headquarter_id: 2,
    class_type_id: 1,
    start_hour: 540,
    start_date: "2026-08-27 09:00:00",
    course_level_group_name: "B1",
    reserved: 0,
    max_student: 6,
    ...overrides,
  };
}

test("uses Bogota date parts without depending on the host timezone", () => {
  const parts = getBogotaParts(new Date("2026-08-27T03:30:00.000Z"));
  assert.deepEqual(
    { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour },
    { year: 2026, month: 8, day: 26, hour: 22 },
  );
});

test("builds a three-date, exclusive-end scan window", () => {
  assert.deepEqual(
    buildScanRange(new Date("2026-08-27T15:00:00.000Z")),
    { startDate: "2026-08-27", endDateExclusive: "2026-08-30" },
  );
});

test("only applies weekday openings on weekdays and Saturday openings on Saturday", () => {
  assert.equal(classifySweep(new Date("2026-08-27T14:00:00.000Z")).mode, "BURST"); // Thu 09:00
  assert.equal(classifySweep(new Date("2026-08-29T13:15:00.000Z")).mode, "BURST"); // Sat 08:15
  assert.equal(classifySweep(new Date("2026-08-30T14:00:00.000Z")).mode, "SKIPPED"); // Sun 09:00
  assert.equal(classifySweep(new Date("2026-08-27T14:01:00.000Z")).mode, "PLUS_1");
  assert.equal(classifySweep(new Date("2026-08-27T14:02:00.000Z")).mode, "BACKOFF");
  assert.equal(classifySweep(new Date("2026-08-27T14:30:00.000Z")).mode, "HOURLY");
});

test("matches B1 exactly and accepts grouped B1 courses", () => {
  assert.equal(levelsMatch("B1", "B1"), true);
  assert.equal(levelsMatch("B1", "B1-B2"), true);
  assert.equal(levelsMatch("B1", "A2-B1"), true);
  assert.equal(levelsMatch("B1", "A2"), false);
  assert.equal(levelsMatch("B1", "B10"), false);
});

test("accepts an eligible B1 schedule", () => {
  assert.deepEqual(
    filterSchedule(schedule(), config, new Set(), new Date("2026-08-26T15:00:00.000Z")),
    { accepted: true, reason: "ELIGIBLE", scheduleId: 101 },
  );
});

test("rejects unsafe or unwanted schedules", () => {
  const now = new Date("2026-08-26T15:00:00.000Z");
  assert.equal(filterSchedule(schedule({ course_level_group_name: "A2" }), config, new Set(), now).reason, "LEVEL_MISMATCH");
  assert.equal(filterSchedule(schedule({ reserved: 6 }), config, new Set(), now).reason, "FULL");
  assert.equal(filterSchedule(schedule({ id: 999 }), config, new Set([999]), now).reason, "ALREADY_HANDLED");
  assert.equal(filterSchedule(schedule({ start_date: "2026-08-27 09:00:00" }), config, new Set(), new Date("2026-08-27T13:01:00.000Z")).reason, "INSUFFICIENT_LEAD_TIME");
  assert.equal(filterSchedule(schedule({ start_date: "2026-08-29 09:00:00" }), config, new Set(), now).reason, "DAY_NOT_ALLOWED");
  assert.equal(filterSchedule(schedule({ headquarter_id: "2", class_type_id: "1" }), config, new Set(), now).accepted, true);
  assert.equal(filterSchedule(schedule({ start_date: "2026-02-31 09:00:00" }), config, new Set(), now).reason, "INVALID_DATE");
  assert.equal(
    filterSchedule(schedule({ start_hour: 600 }), { ...config, blockedSlots: [{ date: "2026-08-27", startHour: 600 }] }, new Set(), now).reason,
    "BLOCKED_SLOT",
  );
});

test("sorts schedules chronologically and removes no data", () => {
  const result = sortSchedules([
    schedule({ id: 3, start_date: "2026-08-28 09:00:00" }),
    schedule({ id: 2, start_date: "2026-08-27 10:00:00" }),
    schedule({ id: 1, start_date: "2026-08-27 09:00:00" }),
  ]);
  assert.deepEqual(result.map(({ id }) => id), [1, 2, 3]);
});

test("classifies booking responses without broad substring matches", () => {
  assert.equal(isAlreadyBookedResponse(409, { message: "conflicto de horario" }), true);
  assert.equal(isAlreadyBookedResponse(422, { message: "La clase no tiene profesor" }), false);
  assert.equal(isAlreadyBookedResponse(422, { message: "Ya tienes una clase asignada" }), true);
  assert.equal(isAlreadyBookedResponse(422, { message: "mayor disponibilidad" }), false);
  assert.equal(isSuccessfulBookingResponse({ ok: true, body: { success: true } }), true);
  assert.equal(isSuccessfulBookingResponse({ ok: true, body: { data: [] } }), true);
  assert.equal(isSuccessfulBookingResponse({ ok: true, body: { data: null } }), false);
  assert.equal(isSuccessfulBookingResponse({ ok: true, body: { error: "rejected", data: null } }), false);
  assert.equal(isSuccessfulBookingResponse({ ok: false, body: { success: true } }), false);
});
