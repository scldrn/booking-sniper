export type JsonObject = Record<string, unknown>;

export interface RawStudentConfig extends JsonObject {
  id?: string;
  enrollment_id?: number;
  third_party_id?: number;
  headquarter_id?: number;
  language_id?: number;
  class_type_id?: number;
  min_start_minutes?: number;
  max_start_minutes?: number;
  min_start_hour_minutes?: number;
  max_start_hour_minutes?: number;
  allowed_days?: number[];
  target_level?: string;
  level_group_name?: string;
  booking_hours_range?: number;
  minimum_lead_time_hours?: number;
  blocked_slots?: Array<{ date?: string; startHour?: number; start_hour?: number }>;
}

export interface BookingConfig {
  enrollmentId: number;
  thirdPartyId: number;
  headquarterId: number;
  languageId: number;
  classTypeId: number;
  minStartMinutes: number;
  maxStartMinutes: number;
  allowedDays: number[];
  targetLevel: string;
  bookingHoursRange: number;
  minimumLeadTimeHours: number;
  blockedSlots: Array<{ date: string; startHour: number }>;
}

export interface Schedule extends JsonObject {
  id?: number;
  headquarter_id?: number;
  class_type_id?: number;
  start_hour?: number;
  start_date?: string;
  end_date?: string;
  reserved?: number;
  max_student?: number;
  course_level_group_name?: string;
}

export type SweepMode = "BURST" | "PLUS_1" | "BACKOFF" | "HOURLY" | "SKIPPED";
