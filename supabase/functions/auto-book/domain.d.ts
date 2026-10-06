import type { BookingConfig, Schedule, SweepMode } from "./types.ts";

export const WEEKDAY_OPENING_MINUTES: readonly number[];
export const SATURDAY_OPENING_MINUTES: readonly number[];
export const BACKOFF_MINUTES: readonly number[];

export function getBogotaParts(date?: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};
export function dateKeyFromParts(parts: { year: number; month: number; day: number }): string;
export function getBogotaDateKey(date?: Date): string;
export function addDays(dateKey: string, days: number): string;
export function dayOfWeekForDateKey(dateKey: string): number;
export function buildScanRange(date?: Date, days?: number): {
  startDate: string;
  endDateExclusive: string;
};
export function openingMinutesForDay(dayOfWeek: number): readonly number[];
export function classifySweep(date?: Date): {
  mode: SweepMode;
  dateKey: string;
  dayOfWeek: number;
  openingMinutes: readonly number[];
};
export function parseBogotaDateTime(value: unknown): number;
export function dateKeyFromSchedule(schedule: Schedule): string;
export function extractLevelCodes(value: unknown): string[];
export function levelsMatch(targetLevel: unknown, courseLevel: unknown): boolean;
export function filterSchedule(
  schedule: Schedule,
  config: BookingConfig,
  ignoredIds?: Set<number>,
  now?: Date,
): { accepted: boolean; reason: string; scheduleId?: number };
export function sortSchedules(schedules: Schedule[]): Schedule[];
export function bookingMessage(body: unknown): string;
export function isAlreadyBookedResponse(status: number, body: unknown): boolean;
export function isSuccessfulBookingResponse(response: { ok: boolean; body: unknown }): boolean;
