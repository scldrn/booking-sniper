import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";
import { normalizeStudentConfig, readRuntimeEnv } from "./config.ts";
import {
  buildScanRange,
  classifySweep,
  filterSchedule,
  isAlreadyBookedResponse,
  isSuccessfulBookingResponse,
  sortSchedules,
} from "./domain.js";
import { LcnApiError, LcnClient } from "./lcnClient.ts";
import {
  acquireSweepLock,
  BookingLogger,
  loadConfig,
  loadIgnoredScheduleIds,
  releaseSweepLock,
} from "./repository.ts";
import type { Schedule, SweepMode } from "./types.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAuthorizedTrigger(req: Request, expectedSecret: string): boolean {
  return req.headers.get("x-auto-book-trigger") === expectedSecret;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runSweep(
  supabase: ReturnType<typeof createClient>,
  logger: BookingLogger,
  mode: SweepMode,
  now: Date,
  env: ReturnType<typeof readRuntimeEnv>,
): Promise<number> {
  const rawConfig = await loadConfig(supabase);
  const config = normalizeStudentConfig(rawConfig);
  const { startDate, endDateExclusive } = buildScanRange(now, 3);
  const ignoredIds = await loadIgnoredScheduleIds(supabase);
  const client = new LcnClient(env.lcnEmail, env.lcnPassword, { timeoutMs: env.requestTimeoutMs });

  await logger.info(`Starting ${mode} sweep`, {
    start_date: startDate,
    end_date_exclusive: endDateExclusive,
    target_level: config.targetLevel,
  });
  await client.login();

  const attemptSweep = async (attemptName: string): Promise<number> => {
    let schedules: Schedule[];
    try {
      schedules = await client.getSchedules(config, startDate, endDateExclusive);
    } catch (error) {
      await logger.failed(`[${attemptName}] Could not read schedule board`, undefined, {
        error: errorMessage(error),
      });
      return 0;
    }

    const seenIds = new Set<number>();
    const matches = sortSchedules(
      schedules.filter((schedule) => {
        const decision = filterSchedule(schedule, config, ignoredIds, now);
        if (!decision.accepted || decision.scheduleId === undefined) return false;
        if (seenIds.has(decision.scheduleId)) return false;
        seenIds.add(decision.scheduleId);
        return true;
      }),
    );

    await logger.info(`[${attemptName}] Eligible ${config.targetLevel} slots: ${matches.length}`);
    let bookedCount = 0;

    for (const schedule of matches) {
      const scheduleId = Number(schedule.id);
      await logger.info(`[${attemptName}] Attempting schedule ${scheduleId}`, {
        start_date: schedule.start_date,
        course_level_group_name: schedule.course_level_group_name,
      });

      try {
        const response = await client.bookSchedule(schedule, config);
        if (isSuccessfulBookingResponse(response)) {
          await logger.success(
            `[${attemptName}] Successfully booked schedule ${scheduleId}`,
            scheduleId,
            response.body,
          );
          ignoredIds.add(scheduleId);
          bookedCount += 1;
          continue;
        }

        if (isAlreadyBookedResponse(response.status, response.body)) {
          await logger.alreadyBooked(
            `[${attemptName}] Schedule ${scheduleId} is already booked or conflicts`,
            scheduleId,
            { status: response.status, response: response.body },
          );
          ignoredIds.add(scheduleId);
          continue;
        }

        await logger.failed(`[${attemptName}] Booking rejected for schedule ${scheduleId}`, scheduleId, {
          status: response.status,
          response: response.body,
        });
      } catch (error) {
        await logger.failed(`[${attemptName}] Network error for schedule ${scheduleId}`, scheduleId, {
          error: errorMessage(error),
        });
      }
    }

    return bookedCount;
  };

  let totalBooked = 0;
  if (mode === "BURST") {
    for (const [index, waitMs] of [0, 10000, 10000, 10000, 10000, 10000].entries()) {
      if (index > 0) await delay(waitMs);
      totalBooked += await attemptSweep(`${index * 10}s`);
      if (totalBooked > 0) break;
    }
  } else if (mode === "PLUS_1") {
    totalBooked += await attemptSweep("1m");
    if (totalBooked === 0) {
      await delay(30000);
      totalBooked += await attemptSweep("1m30s");
    }
  } else {
    totalBooked += await attemptSweep("scheduled");
  }

  return totalBooked;
}

serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Only POST is supported" }, 405);

  let env: ReturnType<typeof readRuntimeEnv>;
  try {
    env = readRuntimeEnv((name) => Deno.env.get(name));
  } catch (error) {
    return json({ error: errorMessage(error) }, 500);
  }

  if (!isAuthorizedTrigger(req, env.triggerSecret)) {
    return json({ error: "Unauthorized trigger" }, 401);
  }

  if (!env.bookingEnabled) {
    return json({
      success: true,
      dry_run: true,
      booking_enabled: false,
      reason: "booking_disabled",
    });
  }

  const now = new Date();
  const sweep = classifySweep(now);
  if (sweep.mode === "SKIPPED") {
    return json({ skipped: true, reason: "outside_schedule", date: sweep.dateKey });
  }

  const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const requestId = crypto.randomUUID();
  const logger = new BookingLogger(supabase, requestId);

  try {
    const acquired = await acquireSweepLock(supabase, requestId, env.lockTtlSeconds);
    if (!acquired) return json({ skipped: true, reason: "another_sweep_is_active" });

    try {
      const booked = await runSweep(supabase, logger, sweep.mode, now, env);
      await logger.info(`Sweep completed with ${booked} booking(s)`);
      return json({ success: true, mode: sweep.mode, booked, request_id: requestId });
    } finally {
      try {
        const released = await releaseSweepLock(supabase, requestId);
        if (!released) await logger.failed("Sweep lock was not owned at release time");
      } catch (error) {
        await logger.failed("Could not release sweep lock", undefined, { error: errorMessage(error) });
      }
    }
  } catch (error) {
    const details = error instanceof LcnApiError
      ? { error: error.message, status: error.status }
      : { error: errorMessage(error) };
    await logger.failed("Auto-book sweep failed", undefined, details);
    return json({ error: "Auto-book sweep failed", request_id: requestId }, 500);
  }
});
