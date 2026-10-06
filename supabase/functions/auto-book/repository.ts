import type { RawStudentConfig } from "./types.ts";

interface SupabaseLike {
  from(table: string): any;
  rpc(name: string, params: Record<string, unknown>): any;
}

export async function loadConfig(supabase: SupabaseLike): Promise<RawStudentConfig> {
  const { data, error } = await supabase
    .from("student_config")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(1);

  if (error) throw new Error(`Could not load student configuration: ${error.message}`);
  if (!Array.isArray(data) || data.length === 0) throw new Error("No student configuration found");
  return data[0] as RawStudentConfig;
}

export async function loadIgnoredScheduleIds(supabase: SupabaseLike): Promise<Set<number>> {
  const { data, error } = await supabase
    .from("booking_logs")
    .select("schedule_id")
    .in("status", ["SUCCESS", "ALREADY_BOOKED"])
    .not("schedule_id", "is", null);

  if (error) throw new Error(`Could not load handled schedules: ${error.message}`);

  return new Set(
    (data ?? [])
      .map((row: { schedule_id?: unknown }) => Number(row.schedule_id))
      .filter((id: number) => Number.isInteger(id)),
  );
}

export async function acquireSweepLock(
  supabase: SupabaseLike,
  ownerId: string,
  ttlSeconds: number,
): Promise<boolean> {
  const { data, error } = await supabase.rpc("try_acquire_booking_lock", {
    p_lock_name: "auto-book",
    p_owner_id: ownerId,
    p_ttl_seconds: ttlSeconds,
  });
  if (error) throw new Error(`Could not acquire sweep lock: ${error.message}`);
  return data === true;
}

export async function releaseSweepLock(supabase: SupabaseLike, ownerId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("release_booking_lock", {
    p_lock_name: "auto-book",
    p_owner_id: ownerId,
  });
  if (error) throw new Error(`Could not release sweep lock: ${error.message}`);
  return data === true;
}

export type LoggerStatus = "INFO" | "SUCCESS" | "FAILED" | "ALREADY_BOOKED";

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (typeof value === "string") {
    const redacted = value
      .replace(/Bearer\s+eyJ[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
      .replace(/(XSRF-TOKEN|lcn_idiomas_session)=[^;\s]+/gi, "$1=[redacted]");
    return redacted.length > 3000 ? `${redacted.slice(0, 3000)}…` : redacted;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, depth + 1));

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      /password|token|cookie|authorization|secret/i.test(key)
        ? "[redacted]"
        : sanitize(item, depth + 1),
    ]),
  );
}

export class BookingLogger {
  constructor(private readonly supabase: SupabaseLike, private readonly requestId: string) {}

  async info(message: string, details?: unknown): Promise<void> {
    await this.write("INFO", message, undefined, details);
  }

  async success(message: string, scheduleId: number, details?: unknown): Promise<void> {
    await this.write("SUCCESS", message, scheduleId, details);
  }

  async failed(message: string, scheduleId?: number, details?: unknown): Promise<void> {
    await this.write("FAILED", message, scheduleId, details);
  }

  async alreadyBooked(message: string, scheduleId: number, details?: unknown): Promise<void> {
    await this.write("ALREADY_BOOKED", message, scheduleId, details);
  }

  private async write(
    status: LoggerStatus,
    message: string,
    scheduleId?: number,
    details?: unknown,
  ): Promise<void> {
    const prefix = `[${this.requestId}]`;
    const output = `${prefix} ${status}: ${message}`;
    if (status === "FAILED") console.error(output);
    else console.log(output);

    const detailObject = details && typeof details === "object" ? details : { value: details };
    const payload: Record<string, unknown> = {
      status,
      message,
      details: sanitize({ ...(detailObject as object), request_id: this.requestId }),
    };
    if (scheduleId !== undefined) payload.schedule_id = scheduleId;

    try {
      const { error } = await this.supabase.from("booking_logs").insert(payload);
      if (error) console.error(`${prefix} Could not write booking log: ${error.message}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${prefix} Could not write booking log: ${message}`);
    }
  }
}

export { sanitize as sanitizeLogDetails };
