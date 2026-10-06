import type { BookingConfig, RawStudentConfig } from "./types.ts";

function requiredInteger(value: unknown, field: string): number {
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new Error(`${field} is required`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`Invalid integer in ${field}`);
  return parsed;
}

function requiredPositiveInteger(value: unknown, field: string): number {
  const parsed = requiredInteger(value, field);
  if (parsed <= 0) throw new Error(`${field} must be positive`);
  return parsed;
}

function boundedNumber(value: unknown, field: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid value in ${field}`);
  }
  return parsed;
}

function boundedInteger(value: unknown, field: string, min: number, max: number): number {
  const parsed = requiredInteger(value, field);
  if (parsed < min || parsed > max) throw new Error(`Invalid value in ${field}`);
  return parsed;
}

function readAllowedDays(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("allowed_days must contain at least one day");
  }

  const days = [...new Set(value.map((day) => requiredInteger(day, "allowed_days")))];
  if (days.some((day) => day < 0 || day > 6)) {
    throw new Error("allowed_days values must be between 0 and 6");
  }
  return days;
}

function readBlockedSlots(value: unknown): Array<{ date: string; startHour: number }> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("blocked_slots must be an array");

  return value.map((slot) => {
    const candidate = slot as Record<string, unknown>;
    const date = String(candidate.date ?? "");
    const startHour = Number(candidate.startHour ?? candidate.start_hour);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isInteger(startHour) ||
      startHour < 0 ||
      startHour > 1439
    ) {
      throw new Error("Each blocked slot needs date and startHour");
    }
    return { date, startHour };
  });
}

export function normalizeStudentConfig(row: RawStudentConfig): BookingConfig {
  const enrollmentId = requiredPositiveInteger(row.enrollment_id, "enrollment_id");
  const thirdPartyId = requiredPositiveInteger(row.third_party_id, "third_party_id");
  const headquarterId = requiredPositiveInteger(row.headquarter_id ?? 2, "headquarter_id");
  const languageId = requiredPositiveInteger(row.language_id ?? 70, "language_id");
  const classTypeId = requiredPositiveInteger(row.class_type_id ?? 1, "class_type_id");
  const minStartMinutes = requiredInteger(
    row.min_start_minutes ?? row.min_start_hour_minutes ?? 540,
    "min_start_minutes",
  );
  const maxStartMinutes = requiredInteger(
    row.max_start_minutes ?? row.max_start_hour_minutes ?? 810,
    "max_start_minutes",
  );
  const allowedDays = readAllowedDays(row.allowed_days ?? [1, 2, 3, 4, 5]);
  const targetLevel = String(
    (typeof row.target_level === "string" && row.target_level.trim() !== ""
      ? row.target_level
      : row.level_group_name ?? ""),
  ).trim().toUpperCase();
  const bookingHoursRange = requiredInteger(row.booking_hours_range ?? 48, "booking_hours_range");
  const minimumLeadTimeHours = boundedNumber(
    row.minimum_lead_time_hours ?? 4,
    "minimum_lead_time_hours",
    0,
    72,
  );

  if (minStartMinutes < 0 || maxStartMinutes > 1439 || minStartMinutes > maxStartMinutes) {
    throw new Error("The configured start-time range is invalid");
  }
  if (targetLevel === "") throw new Error("target_level is required");
  if (!/\b[A-C][1-2]\b/.test(targetLevel)) {
    throw new Error("target_level must contain a valid CEFR code");
  }
  if (bookingHoursRange < 1 || bookingHoursRange > 168) {
    throw new Error("booking_hours_range must be between 1 and 168");
  }

  return {
    enrollmentId,
    thirdPartyId,
    headquarterId,
    languageId,
    classTypeId,
    minStartMinutes,
    maxStartMinutes,
    allowedDays,
    targetLevel,
    bookingHoursRange,
    minimumLeadTimeHours,
    blockedSlots: readBlockedSlots(row.blocked_slots),
  };
}

export interface RuntimeEnv {
  bookingEnabled: boolean;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  lcnEmail: string;
  lcnPassword: string;
  triggerSecret: string;
  lockTtlSeconds: number;
  requestTimeoutMs: number;
}

function requiredEnv(getEnv: (name: string) => string | undefined, name: string): string {
  const value = getEnv(name)?.trim();
  if (!value) throw new Error(`${name} secret is missing`);
  return value;
}

function booleanEnv(value: string | undefined, field: string, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === "") return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  throw new Error(`${field} must be true or false`);
}

export function readRuntimeEnv(getEnv: (name: string) => string | undefined): RuntimeEnv {
  const bookingEnabled = booleanEnv(getEnv("AUTO_BOOK_ENABLED"), "AUTO_BOOK_ENABLED", false);

  return {
    bookingEnabled,
    supabaseUrl: requiredEnv(getEnv, "SUPABASE_URL"),
    supabaseServiceRoleKey: bookingEnabled
      ? requiredEnv(getEnv, "SUPABASE_SERVICE_ROLE_KEY")
      : getEnv("SUPABASE_SERVICE_ROLE_KEY")?.trim() ?? "",
    lcnEmail: bookingEnabled ? requiredEnv(getEnv, "LCN_EMAIL") : getEnv("LCN_EMAIL")?.trim() ?? "",
    lcnPassword: bookingEnabled ? requiredEnv(getEnv, "LCN_PASSWORD") : getEnv("LCN_PASSWORD")?.trim() ?? "",
    triggerSecret: requiredEnv(getEnv, "AUTO_BOOK_TRIGGER_SECRET"),
    lockTtlSeconds: boundedInteger(getEnv("AUTO_BOOK_LOCK_TTL_SECONDS") ?? 180, "AUTO_BOOK_LOCK_TTL_SECONDS", 60, 900),
    requestTimeoutMs: boundedInteger(getEnv("LCN_REQUEST_TIMEOUT_MS") ?? 8000, "LCN_REQUEST_TIMEOUT_MS", 1000, 30000),
  };
}
