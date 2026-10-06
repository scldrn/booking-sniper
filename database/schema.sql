-- Canonical schema for the LCN class-booking service.
-- Run this on a new Supabase project. Existing installations should run
-- database/migrations/20260826_harden_and_move_to_b1.sql as well.

CREATE TABLE IF NOT EXISTS public.student_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  enrollment_id BIGINT NOT NULL,
  third_party_id BIGINT NOT NULL,
  headquarter_id BIGINT NOT NULL DEFAULT 2,
  language_id BIGINT NOT NULL DEFAULT 70,
  class_type_id BIGINT NOT NULL DEFAULT 1,

  min_start_minutes INTEGER NOT NULL DEFAULT 540,
  max_start_minutes INTEGER NOT NULL DEFAULT 810,
  allowed_days SMALLINT[] NOT NULL DEFAULT ARRAY[1, 2, 3, 4, 5]::SMALLINT[],
  target_level TEXT NOT NULL DEFAULT 'B1',
  booking_hours_range INTEGER NOT NULL DEFAULT 48,
  minimum_lead_time_hours NUMERIC(5, 2) NOT NULL DEFAULT 4.00,
  blocked_slots JSONB NOT NULL DEFAULT '[]'::JSONB,

  CONSTRAINT student_config_time_range_check
    CHECK (min_start_minutes BETWEEN 0 AND 1439 AND max_start_minutes BETWEEN 0 AND 1439 AND min_start_minutes <= max_start_minutes),
  CONSTRAINT student_config_allowed_days_check
    CHECK (cardinality(allowed_days) > 0 AND allowed_days <@ ARRAY[0, 1, 2, 3, 4, 5, 6]::SMALLINT[]),
  CONSTRAINT student_config_level_check
    CHECK (length(trim(target_level)) > 0),
  CONSTRAINT student_config_booking_range_check
    CHECK (booking_hours_range BETWEEN 1 AND 168),
  CONSTRAINT student_config_lead_time_check
    CHECK (minimum_lead_time_hours BETWEEN 0 AND 72),
  CONSTRAINT student_config_blocked_slots_check
    CHECK (jsonb_typeof(blocked_slots) = 'array')
);

CREATE TABLE IF NOT EXISTS public.booking_logs (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL CHECK (status IN ('INFO', 'SUCCESS', 'FAILED', 'ALREADY_BOOKED')),
  message TEXT NOT NULL,
  schedule_id BIGINT,
  details JSONB
);

CREATE INDEX IF NOT EXISTS booking_logs_status_schedule_idx
  ON public.booking_logs (status, schedule_id);
CREATE INDEX IF NOT EXISTS booking_logs_created_at_idx
  ON public.booking_logs (created_at DESC);

CREATE TABLE IF NOT EXISTS public.booking_locks (
  lock_name TEXT PRIMARY KEY,
  owner_id UUID NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS student_config_set_updated_at ON public.student_config;
CREATE TRIGGER student_config_set_updated_at
BEFORE UPDATE ON public.student_config
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.try_acquire_booking_lock(
  p_lock_name TEXT,
  p_owner_id UUID,
  p_ttl_seconds INTEGER DEFAULT 180
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  did_acquire BOOLEAN := FALSE;
BEGIN
  IF p_ttl_seconds < 1 OR p_ttl_seconds > 900 THEN
    RAISE EXCEPTION 'Invalid lock TTL';
  END IF;

  INSERT INTO public.booking_locks (lock_name, owner_id, acquired_at, expires_at)
  VALUES (p_lock_name, p_owner_id, now(), now() + make_interval(secs => p_ttl_seconds))
  ON CONFLICT (lock_name) DO UPDATE
    SET owner_id = EXCLUDED.owner_id,
        acquired_at = EXCLUDED.acquired_at,
        expires_at = EXCLUDED.expires_at
    WHERE public.booking_locks.expires_at <= now()
  RETURNING TRUE INTO did_acquire;

  RETURN COALESCE(did_acquire, FALSE);
END;
$$;

CREATE OR REPLACE FUNCTION public.release_booking_lock(
  p_lock_name TEXT,
  p_owner_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM public.booking_locks
  WHERE lock_name = p_lock_name AND owner_id = p_owner_id;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count = 1;
END;
$$;

-- The Edge Function uses the service role only server-side. No client role
-- should be able to read credentials, preferences, locks, or operational logs.
ALTER TABLE public.student_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_locks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.student_config, public.booking_logs, public.booking_locks FROM anon, authenticated;
GRANT ALL ON public.student_config, public.booking_logs, public.booking_locks TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.booking_logs_id_seq TO service_role;
REVOKE ALL ON FUNCTION public.try_acquire_booking_lock(TEXT, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_booking_lock(TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.try_acquire_booking_lock(TEXT, UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_booking_lock(TEXT, UUID) TO service_role;
