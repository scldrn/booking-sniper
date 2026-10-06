const BOGOTA_TIME_ZONE = "America/Bogota";

const bogotaFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: BOGOTA_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export const WEEKDAY_OPENING_MINUTES = Object.freeze([450, 540, 630, 720, 810]);
export const SATURDAY_OPENING_MINUTES = Object.freeze([495, 585, 675]);
export const BACKOFF_MINUTES = Object.freeze([2, 3, 5, 10, 20]);

const CEFR_LEVELS = new Set(["A1", "A2", "B1", "B2", "C1", "C2"]);

function partsToObject(parts) {
  return Object.fromEntries(
    parts
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, Number(value)]),
  );
}

/** Return the current date/time components in the platform's timezone. */
export function getBogotaParts(date = new Date()) {
  return partsToObject(bogotaFormatter.formatToParts(date));
}

export function dateKeyFromParts(parts) {
  return [parts.year, parts.month, parts.day]
    .map((value) => String(value).padStart(2, "0"))
    .join("-");
}

export function getBogotaDateKey(date = new Date()) {
  return dateKeyFromParts(getBogotaParts(date));
}

export function addDays(dateKey, days) {
  if (!isValidDateKey(dateKey)) {
    throw new Error(`Invalid date key: ${dateKey}`);
  }
  const date = new Date(`${dateKey}T12:00:00.000Z`);

  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function dayOfWeekForDateKey(dateKey) {
  if (!isValidDateKey(dateKey)) {
    throw new Error(`Invalid date key: ${dateKey}`);
  }
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  return date.getUTCDay();
}

function isValidDateKey(dateKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return false;
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === dateKey;
}

export function buildScanRange(now = new Date(), days = 3) {
  if (!Number.isInteger(days) || days < 1) {
    throw new Error("Scan range days must be a positive integer");
  }

  const startDate = getBogotaDateKey(now);
  return {
    startDate,
    endDateExclusive: addDays(startDate, days),
  };
}

export function openingMinutesForDay(dayOfWeek) {
  if (dayOfWeek === 6) return SATURDAY_OPENING_MINUTES;
  if (dayOfWeek >= 1 && dayOfWeek <= 5) return WEEKDAY_OPENING_MINUTES;
  return [];
}

function minuteOfDay(parts) {
  return parts.hour * 60 + parts.minute;
}

/** Decide whether this invocation is worth authenticating and scanning. */
export function classifySweep(now = new Date()) {
  const parts = getBogotaParts(now);
  const dateKey = dateKeyFromParts(parts);
  const dayOfWeek = dayOfWeekForDateKey(dateKey);
  const currentMinute = minuteOfDay(parts);
  const openingMinutes = openingMinutesForDay(dayOfWeek);

  if (openingMinutes.includes(currentMinute)) {
    return { mode: "BURST", dateKey, dayOfWeek, openingMinutes };
  }

  if (openingMinutes.includes(currentMinute - 1)) {
    return { mode: "PLUS_1", dateKey, dayOfWeek, openingMinutes };
  }

  if (
    openingMinutes.some((openingMinute) =>
      BACKOFF_MINUTES.includes(currentMinute - openingMinute),
    )
  ) {
    return { mode: "BACKOFF", dateKey, dayOfWeek, openingMinutes };
  }

  if (dayOfWeek !== 0 && (parts.minute === 0 || parts.minute === 30)) {
    return { mode: "HOURLY", dateKey, dayOfWeek, openingMinutes };
  }

  return { mode: "SKIPPED", dateKey, dayOfWeek, openingMinutes };
}

export function parseBogotaDateTime(value) {
  if (typeof value !== "string" || value.trim() === "") return NaN;

  const normalized = value.trim().replace(" ", "T");
  if (!isValidDateKey(normalized.slice(0, 10))) return NaN;
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  const date = new Date(hasTimezone ? normalized : `${normalized}-05:00`);
  return date.getTime();
}

export function dateKeyFromSchedule(schedule) {
  const value = schedule?.start_date;
  return typeof value === "string" ? value.slice(0, 10) : "";
}

export function extractLevelCodes(value) {
  if (typeof value !== "string") return [];

  const normalized = value.toUpperCase().replace(/[–—_/]/g, "-");
  return [...new Set(normalized.match(/\b[A-C][1-2]\b/g) ?? [])].filter((level) =>
    CEFR_LEVELS.has(level),
  );
}

/** Match CEFR groups by their codes, avoiding substring false positives. */
export function levelsMatch(targetLevel, courseLevel) {
  const targetCodes = extractLevelCodes(targetLevel);
  const courseCodes = new Set(extractLevelCodes(courseLevel));

  return targetCodes.some((level) => courseCodes.has(level));
}

function numericValue(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
}

function hasBlockedSlot(schedule, config) {
  const dateKey = dateKeyFromSchedule(schedule);
  const startHour = numericValue(schedule?.start_hour);
  return (config.blockedSlots ?? []).some(
    (slot) =>
      slot?.date === dateKey && numericValue(slot?.startHour) === startHour,
  );
}

/** Pure eligibility filter for deterministic tests and safe booking decisions. */
export function filterSchedule(schedule, config, ignoredIds = new Set(), now = new Date()) {
  const scheduleId = numericValue(schedule?.id);
  if (!Number.isInteger(scheduleId)) return { accepted: false, reason: "INVALID_ID" };
  if (numericValue(schedule.headquarter_id) !== config.headquarterId) {
    return { accepted: false, reason: "WRONG_HEADQUARTER" };
  }
  if (numericValue(schedule.class_type_id) !== config.classTypeId) {
    return { accepted: false, reason: "WRONG_CLASS_TYPE" };
  }

  const startHour = numericValue(schedule.start_hour);
  if (
    !Number.isInteger(startHour) ||
    startHour < config.minStartMinutes ||
    startHour > config.maxStartMinutes
  ) {
    return { accepted: false, reason: "OUTSIDE_TIME_RANGE" };
  }

  const dateKey = dateKeyFromSchedule(schedule);
  let dayOfWeek;
  try {
    dayOfWeek = dayOfWeekForDateKey(dateKey);
  } catch {
    return { accepted: false, reason: "INVALID_DATE" };
  }

  if (!config.allowedDays.includes(dayOfWeek)) {
    return { accepted: false, reason: "DAY_NOT_ALLOWED" };
  }

  if (!levelsMatch(config.targetLevel, schedule.course_level_group_name)) {
    return { accepted: false, reason: "LEVEL_MISMATCH" };
  }

  const reserved = numericValue(schedule.reserved);
  const capacity = numericValue(schedule.max_student);
  if (!Number.isFinite(reserved) || !Number.isFinite(capacity) || capacity <= 0) {
    return { accepted: false, reason: "INVALID_CAPACITY" };
  }
  if (reserved >= capacity) {
    return { accepted: false, reason: "FULL" };
  }

  if (hasBlockedSlot(schedule, config)) {
    return { accepted: false, reason: "BLOCKED_SLOT" };
  }

  const startTimestamp = parseBogotaDateTime(schedule.start_date);
  if (!Number.isFinite(startTimestamp)) {
    return { accepted: false, reason: "INVALID_DATE" };
  }

  const minimumLeadTimeMs = config.minimumLeadTimeHours * 60 * 60 * 1000;
  if (startTimestamp - now.getTime() < minimumLeadTimeMs) {
    return { accepted: false, reason: "INSUFFICIENT_LEAD_TIME" };
  }

  if (ignoredIds.has(scheduleId)) {
    return { accepted: false, reason: "ALREADY_HANDLED" };
  }

  return { accepted: true, reason: "ELIGIBLE", scheduleId };
}

export function sortSchedules(schedules) {
  return [...schedules].sort((left, right) => {
    const leftTime = parseBogotaDateTime(left?.start_date);
    const rightTime = parseBogotaDateTime(right?.start_date);
    if (leftTime !== rightTime) return leftTime - rightTime;
    return numericValue(left?.id) - numericValue(right?.id);
  });
}

export function bookingMessage(body) {
  if (!body || typeof body !== "object") return "";
  const candidate = body;
  const messages = [candidate.message, candidate.error]
    .concat(Array.isArray(candidate.errors) ? candidate.errors : [])
    .filter((value) => typeof value === "string");
  return messages.join(" ").toLowerCase();
}

export function isAlreadyBookedResponse(status, body) {
  const message = bookingMessage(body);
  if (!message) return false;

  const explicitConflict = [
    /ya\s+(?:tienes|est[aá]s|reservaste|registraste)/i,
    /ya\s+(?:est[aá])?\s*(?:asignad|registrad|reservad|agendad)/i,
    /cruzad|cruce|superposici[oó]n|solapad/i,
    /duplicad|conflicto\s+de\s+horario/i,
    /already\s+booked|schedule\s+conflict|overlap/i,
  ].some((pattern) => pattern.test(message));

  return explicitConflict || (status === 409 && /conflict|overlap|duplicat/i.test(message));
}

export function isSuccessfulBookingResponse(response) {
  const body = response?.body;
  if (!response?.ok || !body || typeof body !== "object") return false;
  if (body.success === false || body.error) return false;
  return body.success === true || (body.data !== undefined && body.data !== null);
}
